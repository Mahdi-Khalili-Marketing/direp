import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { boxApi, BoxApiError } from './boxapi.js';
import { sendAlert, detectChatId, AlertChannel } from './alerts.js';
import { DEFAULT_REPLIES, Intent, REPLY_OFF } from './intents.js';
import {
  normalizePhone, getOwner, createOwner, checkLogin, changePassword,
  createSession, destroySession, bearer, requireAuth, rateLimit,
} from './auth.js';
import { listRules, saveRule, deleteRule, toggleRule, getRule } from './rules.js';
import { listInquiries, closeInquiry } from './recovery.js';
import { listContacts } from './contacts.js';

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const INTENTS = Object.keys(DEFAULT_REPLIES) as Intent[];

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function boxApiFailure(res: Response, err: any) {
  const status = err instanceof BoxApiError && err.status === 401 ? 400 : 502;
  return fail(res, status, `خطای BoxAPI: ${err.message}`);
}

export function webhookUrl(req: Request): string {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/webhooks/boxapi?key=${getSetting('webhook_key') || ''}`;
}

export const api = Router();
const authLimiter = rateLimit(10, 15 * 60_000);

// ---------- setup & auth ----------
api.get('/status', (_req, res) => {
  res.json({ setupDone: Boolean(getOwner()), dryRun: config.dryRun });
});

api.post('/setup', authLimiter, (req, res) => {
  if (getOwner()) return fail(res, 409, 'این نصب قبلاً راه‌اندازی شده است');
  const phone = normalizePhone(str(req.body?.phone, 30));
  const name = str(req.body?.name, 100);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!phone) return fail(res, 400, 'شماره موبایل معتبر نیست (مثال: 09121234567)');
  if (!name) return fail(res, 400, 'نام فروشگاه را وارد کنید');
  if (password.length < 8 || password.length > 128) return fail(res, 400, 'رمز عبور باید حداقل ۸ کاراکتر باشد');
  createOwner(phone, name, password);
  setSetting('webhook_key', crypto.randomBytes(24).toString('hex'));
  res.status(201).json({ token: createSession() });
});

api.post('/login', authLimiter, (req, res) => {
  const phone = normalizePhone(str(req.body?.phone, 30));
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!phone || !password || !checkLogin(phone, password)) return fail(res, 401, 'شماره موبایل یا رمز عبور اشتباه است');
  res.json({ token: createSession() });
});

api.post('/logout', requireAuth, (req, res) => {
  destroySession(bearer(req));
  res.json({ status: 'ok' });
});

api.post('/password', requireAuth, authLimiter, (req, res) => {
  const next = typeof req.body?.next === 'string' ? req.body.next : '';
  if (next.length < 8 || next.length > 128) return fail(res, 400, 'رمز عبور جدید باید حداقل ۸ کاراکتر باشد');
  if (!changePassword(String(req.body?.current || ''), next)) return fail(res, 403, 'رمز عبور فعلی اشتباه است');
  res.json({ token: createSession() });
});

// Everything below needs a logged-in owner.
api.use(requireAuth);

// ---------- settings ----------
api.get('/settings', (req, res) => {
  const key = getSetting('boxapi_key');
  const replies: Record<string, { text: string; enabled: boolean; isDefault: boolean }> = {};
  for (const intent of INTENTS) {
    const custom = getSetting(`reply_${intent}`);
    replies[intent] = {
      text: custom && custom !== REPLY_OFF ? custom : DEFAULT_REPLIES[intent],
      enabled: custom !== REPLY_OFF && (custom ?? DEFAULT_REPLIES[intent]) !== '',
      isDefault: custom === undefined,
    };
  }
  res.json({
    owner: getOwner(),
    boxApiKeyHint: key ? `••••${key.slice(-4)}` : null,
    accountId: getSetting('account_id') || null,
    pageUsername: getSetting('page_username') || null,
    webhookUrl: webhookUrl(req),
    hasWebhookSecret: Boolean(getSetting('webhook_secret')),
    alertChannel: getSetting('alert_channel') || 'none',
    alertChatId: getSetting('alert_chat_id') || '',
    hasAlertToken: Boolean(getSetting('alert_bot_token')),
    discountCode: getSetting('discount_code') || '',
    paymentLink: getSetting('payment_link') || '',
    recoveryEnabled: getSetting('recovery_enabled') !== 'false',
    autoReplyEnabled: getSetting('auto_reply_enabled') !== 'false',
    recoveryStep1Text: getSetting('recovery_step1_text') || '',
    recoveryStep2Text: getSetting('recovery_step2_text') || '',
    replies,
    lastFollowEvent: getSetting('last_follow_event') || null,
  });
});

api.put('/settings', (req, res) => {
  const b = req.body || {};
  if ('boxApiKey' in b) {
    setSetting('boxapi_key', str(b.boxApiKey, 300));
    // A new key may belong to a different BoxAPI account; make the owner pick the page again.
    setSetting('account_id', null);
    setSetting('page_username', null);
    setSetting('page_ig_user_id', null);
  }
  if ('webhookSecret' in b) setSetting('webhook_secret', str(b.webhookSecret, 300));
  if ('alertChannel' in b) {
    const channel = str(b.alertChannel, 20);
    if (!['telegram', 'bale', 'none'].includes(channel)) return fail(res, 400, 'کانال هشدار نامعتبر است');
    setSetting('alert_channel', channel === 'none' ? null : channel);
  }
  if ('alertBotToken' in b) setSetting('alert_bot_token', str(b.alertBotToken, 200));
  if ('alertChatId' in b) setSetting('alert_chat_id', str(b.alertChatId, 50));
  if ('discountCode' in b) setSetting('discount_code', str(b.discountCode, 50));
  if ('paymentLink' in b) {
    const link = str(b.paymentLink, 500);
    if (link && !/^https?:\/\//i.test(link)) return fail(res, 400, 'لینک باید با https:// شروع شود');
    setSetting('payment_link', link);
  }
  if ('recoveryEnabled' in b) setSetting('recovery_enabled', b.recoveryEnabled ? null : 'false');
  if ('autoReplyEnabled' in b) setSetting('auto_reply_enabled', b.autoReplyEnabled ? null : 'false');
  if ('recoveryStep1Text' in b) setSetting('recovery_step1_text', str(b.recoveryStep1Text));
  if ('recoveryStep2Text' in b) setSetting('recovery_step2_text', str(b.recoveryStep2Text));
  if (b.replies && typeof b.replies === 'object') {
    for (const intent of INTENTS) {
      const r = b.replies[intent];
      if (!r || typeof r !== 'object') continue;
      if (r.enabled === false) setSetting(`reply_${intent}`, REPLY_OFF);
      else if (r.reset) setSetting(`reply_${intent}`, null);
      else if (typeof r.text === 'string') setSetting(`reply_${intent}`, str(r.text) || null);
    }
  }
  res.json({ status: 'ok' });
});

// ---------- BoxAPI connection ----------
api.post('/boxapi/check', async (_req, res) => {
  try {
    const [info, accounts] = await Promise.all([boxApi.serviceInfo(), boxApi.accounts()]);
    res.json({
      plan: info.data?.plan || null,
      connectUrl: info.data?.instagram_oauth_url || null,
      accounts: (accounts.data || []).map((a) => ({
        id: a.id, username: a.username, isActive: a.is_active !== false, expiresAt: a.expires_at || null,
        instagramUserId: a.instagram_user_id || null,
      })),
    });
  } catch (err: any) {
    boxApiFailure(res, err);
  }
});

api.post('/page', async (req, res) => {
  const accountId = str(req.body?.accountId, 100);
  try {
    const account = (await boxApi.accounts()).data?.find((a) => a.id === accountId);
    if (!account) return fail(res, 404, 'این پیج در حساب BoxAPI شما پیدا نشد');
    setSetting('account_id', account.id);
    setSetting('page_username', account.username);
    setSetting('page_ig_user_id', account.instagram_user_id || null);
    res.json({ accountId: account.id, username: account.username });
  } catch (err: any) {
    boxApiFailure(res, err);
  }
});

api.post('/alerts/test', async (req, res) => {
  const channel = str(req.body?.channel, 20) as AlertChannel;
  const botToken = str(req.body?.botToken, 200) || getSetting('alert_bot_token') || '';
  const chatId = str(req.body?.chatId, 50) || getSetting('alert_chat_id') || '';
  if (!['telegram', 'bale'].includes(channel) || !botToken || !chatId) return fail(res, 400, 'کانال، توکن ربات و شناسه چت لازم است');
  const ok = await sendAlert('✅ <b>Direp</b>: هشدارها به این چت ارسال می‌شوند.', { channel, botToken, chatId });
  ok ? res.json({ status: 'ok' }) : fail(res, 502, 'ارسال پیام تست ناموفق بود. توکن و شناسه چت را بررسی کنید.');
});

api.post('/alerts/detect-chat', async (req, res) => {
  const channel = str(req.body?.channel, 20) as AlertChannel;
  const botToken = str(req.body?.botToken, 200) || getSetting('alert_bot_token') || '';
  if (!['telegram', 'bale'].includes(channel) || !botToken) return fail(res, 400, 'اول پیام‌رسان و توکن ربات را وارد کنید');
  const result = await detectChatId(channel, botToken);
  'error' in result ? fail(res, 422, result.error) : res.json(result);
});

// ---------- rules ----------
function parseRule(body: any) {
  const keyword = str(body?.keyword, 300);
  const dmText = str(body?.dmText, 1000);
  const matchType = ['CONTAINS', 'EXACT', 'ANY'].includes(body?.matchType) ? body.matchType : 'CONTAINS';
  if ((!keyword && matchType !== 'ANY') || !dmText) return null;
  const buttonUrl = str(body?.buttonUrl, 500);
  if (buttonUrl && !/^https?:\/\//i.test(buttonUrl)) return null;
  return {
    keyword, matchType, dmText, buttonUrl,
    commentReplies: Array.isArray(body?.commentReplies) ? body.commentReplies.map((r: unknown) => str(r, 300)).slice(0, 10) : [],
    requireFollow: Boolean(body?.requireFollow),
    unfollowedDm: str(body?.unfollowedDm, 1000),
    buttonTitle: str(body?.buttonTitle, 20),
  };
}

api.get('/rules', (_req, res) => res.json(listRules()));

api.post('/rules', (req, res) => {
  const rule = parseRule(req.body);
  if (!rule) return fail(res, 400, 'کلمه کلیدی و متن دایرکت لازم است (لینک باید با https شروع شود)');
  res.status(201).json(saveRule(rule));
});

api.put('/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const rule = parseRule(req.body);
  if (!getRule(id)) return fail(res, 404, 'قانون پیدا نشد');
  if (!rule) return fail(res, 400, 'کلمه کلیدی و متن دایرکت لازم است (لینک باید با https شروع شود)');
  res.json(saveRule({ ...rule, id, isActive: getRule(id)!.isActive }));
});

api.post('/rules/:id/toggle', (req, res) =>
  toggleRule(Number(req.params.id)) ? res.json({ status: 'ok' }) : fail(res, 404, 'قانون پیدا نشد')
);

api.delete('/rules/:id', (req, res) =>
  deleteRule(Number(req.params.id)) ? res.json({ status: 'ok' }) : fail(res, 404, 'قانون پیدا نشد')
);

// ---------- carts, contacts, posts ----------
api.get('/inquiries', (_req, res) => res.json(listInquiries()));

api.post('/inquiries/:recipientId/close', (req, res) => {
  const status = req.body?.status === 'PAID' ? 'PAID' : 'CANCELLED';
  res.json({ closed: closeInquiry(String(req.params.recipientId), status) });
});

api.get('/contacts', (_req, res) => res.json(listContacts()));

api.post('/contacts/:id/dm', async (req, res) => {
  const accountId = getSetting('account_id');
  const message = str(req.body?.message, 1000);
  if (!accountId) return fail(res, 400, 'اول پیج اینستاگرام را وصل کنید');
  if (!message) return fail(res, 400, 'متن پیام خالی است');
  try {
    await boxApi.sendMessage(accountId, String(req.params.id), message);
    res.json({ status: 'ok' });
  } catch (err: any) {
    boxApiFailure(res, err);
  }
});

api.get('/posts', (_req, res) => {
  res.json(db().prepare('SELECT * FROM posts ORDER BY posted_at DESC LIMIT 60').all());
});

api.post('/posts/sync', async (_req, res) => {
  const accountId = getSetting('account_id');
  if (!accountId) return fail(res, 400, 'اول پیج اینستاگرام را وصل کنید');
  try {
    await boxApi.requestPosts(accountId);
    res.json({ status: 'queued' });
  } catch (err: any) {
    boxApiFailure(res, err);
  }
});

api.get('/stats', (_req, res) => {
  const one = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  res.json({
    contacts: one('SELECT COUNT(*) AS n FROM contacts'),
    inquiriesPending: one("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'PENDING'"),
    inquiriesPaid: one("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'PAID'"),
    inquiriesTotal: one('SELECT COUNT(*) AS n FROM inquiries'),
    activeRules: one('SELECT COUNT(*) AS n FROM rules WHERE is_active = 1'),
  });
});
