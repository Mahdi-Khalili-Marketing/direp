import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { db, getSetting, setSetting } from './db.js';
import { boxApi } from './boxapi.js';
import { alerts } from './alerts.js';
import { detectIntent, replyFor } from './intents.js';
import { handleComment, handleFollowResult, CommentEvent } from './rules.js';
import { registerInquiry, touchWindow, closeInquiry } from './recovery.js';
import { upsertContact, recordOrder, extractPhone } from './contacts.js';

const MAX_SKEW_SECONDS = 300;

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * BoxAPI signs deliveries when a webhook secret is set in its panel:
 *   X-BoxApi-Signature = "sha256=" + HMAC_SHA256("{timestamp}.{raw body}", secret)
 * Without a secret we require the per-install ?key= token from the webhook URL,
 * so the endpoint is never open to anyone who guesses it.
 */
export function verifyWebhook(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = getSetting('webhook_secret');
  if (secret) {
    const signature = String(req.headers['x-boxapi-signature'] || '');
    const timestamp = String(req.headers['x-boxapi-timestamp'] || '');
    if (!signature || !timestamp) return { ok: false, status: 401, error: 'missing signature' };
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
      return { ok: false, status: 401, error: 'stale timestamp' };
    }
    const raw: Buffer = (req as any).rawBody || Buffer.from('');
    const expected =
      'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
    return safeEqual(signature, expected) ? { ok: true } : { ok: false, status: 401, error: 'bad signature' };
  }
  const key = getSetting('webhook_key');
  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (key && provided && safeEqual(provided, key)) return { ok: true };
  return { ok: false, status: 401, error: 'bad key' };
}

/** BoxAPI retries up to 3 times; remember event ids so a retry never double-replies. */
function alreadySeen(eventId?: string): boolean {
  if (!eventId) return false;
  const inserted = db()
    .prepare('INSERT OR IGNORE INTO seen_events (event_id, received_at) VALUES (?, ?)')
    .run(eventId, Date.now()).changes;
  if (Math.random() < 0.01) {
    db().prepare('DELETE FROM seen_events WHERE received_at < ?').run(Date.now() - 7 * 86400_000);
  }
  return inserted === 0;
}

export async function webhookHandler(req: Request, res: Response) {
  const check = verifyWebhook(req);
  if (!check.ok) return res.status(check.status).json({ error: check.error });

  const payload = req.body || {};
  if (alreadySeen(payload.event_id)) return res.json({ status: 'duplicate' });

  // Acknowledge first: BoxAPI retries slow deliveries, and replies can take seconds.
  res.json({ status: 'ok' });
  processEvent(payload).catch((err) => console.error('[webhook] processing failed:', err.message));
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const v of values) if (typeof v === 'boolean') return v;
  return undefined;
}

export async function processEvent(payload: any): Promise<void> {
  const accountId: string | undefined = payload.account_id;
  const configured = getSetting('account_id');
  // Ignore events for pages this install does not manage.
  if (!accountId || (configured && accountId !== configured)) return;

  const type = String(payload.event_type || '');
  const data = payload.data || {};

  if (type === 'action.list_posts') {
    storePosts(data.result?.data || data.data || (Array.isArray(data) ? data : []));
    return;
  }

  if (type.includes('follow')) {
    // Observed live (2026-10-06): data.result = { is_user_follow_business, customer_id }.
    // The docs do not show it, so keep the latest one for troubleshooting.
    setSetting('last_follow_event', JSON.stringify(payload).slice(0, 4000));
    const result = data.result ?? data;
    const customerId = String(result.customer_id ?? data.request?.customer_id ?? data.customer_id ?? '');
    const following = pickBoolean(result.is_user_follow_business, result.is_following, result.data?.is_following);
    if (customerId && following !== undefined) await handleFollowResult(accountId, customerId, following);
    return;
  }

  if (type === 'comments' || data.from) {
    if (data.from) await handleComment(accountId, data as CommentEvent);
    for (const entry of data.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'comments' && change.value) await handleComment(accountId, change.value);
      }
    }
    return;
  }

  if (type === 'messaging' || data.sender || data.messaging || data.entry) {
    const items = data.sender ? [data] : [...(data.messaging || []), ...(data.entry || []).flatMap((e: any) => e.messaging || [])];
    for (const item of items) await handleMessage(accountId, item);
  }
}

function storePosts(posts: any[]) {
  const upsert = db().prepare(
    `INSERT INTO posts (id, caption, media_type, media_url, permalink, posted_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, media_url = excluded.media_url, permalink = excluded.permalink`
  );
  for (const p of posts) {
    if (!p?.id) continue;
    upsert.run(String(p.id), p.caption ?? null, p.media_type ?? null, p.thumbnail_url || p.media_url || null, p.permalink ?? null, p.timestamp ?? null);
  }
}

async function handleMessage(accountId: string, item: any) {
  const senderId = item.sender?.id ? String(item.sender.id) : '';
  const message = item.message || {};
  const pageIgId = getSetting('page_ig_user_id');
  // Messages the page itself sent come back as echoes; never answer ourselves.
  if (!senderId || message.is_echo || senderId === pageIgId) return;

  const text: string = message.text || '';
  const now = Date.now();
  upsertContact(senderId, { lastMessageAt: now, phone: extractPhone(text) });
  touchWindow(senderId, now);

  if (!text) {
    // Photos are usually payment receipts or product screenshots; a human should look.
    if (message.attachments?.length) alerts.receipt(senderId, '[تصویر / فایل]').catch(() => {});
    return;
  }

  const intent = detectIntent(text);
  if (intent === 'COMPLAINT') {
    upsertContact(senderId, { stage: 'COMPLAINT' });
    alerts.complaint(senderId, text).catch(() => {});
  } else if (intent === 'PAYMENT_RECEIPT') {
    closeInquiry(senderId, 'PAID');
    recordOrder(senderId);
    alerts.receipt(senderId, text).catch(() => {});
  } else if (intent === 'PRICE_INQUIRY') {
    upsertContact(senderId, { stage: 'INQUIRY' });
    registerInquiry(senderId, undefined, now);
  }

  const reply = getSetting('auto_reply_enabled') === 'false' ? '' : replyFor(intent);
  if (reply) {
    await boxApi.sendMessage(accountId, senderId, reply).catch((err) =>
      console.warn(`[webhook] auto-reply to ${senderId} failed: ${err.message}`)
    );
  }
}
