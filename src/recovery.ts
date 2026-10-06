import { db, getSetting } from './db.js';
import { config } from './config.js';
import { boxApi } from './boxapi.js';
import { alerts } from './alerts.js';
import { step1Message, step2Message } from './templates.js';

export interface Inquiry {
  id: number;
  recipientId: string;
  productTitle: string | null;
  status: 'PENDING' | 'DONE' | 'PAID' | 'CANCELLED' | 'EXPIRED';
  nextStep: number | null;
  nextDueAt: number | null;
  windowEndsAt: number;
  createdAt: number;
}

const MIN = 60_000;

function toInquiry(r: any): Inquiry {
  return {
    id: r.id,
    recipientId: r.recipient_id,
    productTitle: r.product_title,
    status: r.status,
    nextStep: r.next_step,
    nextDueAt: r.next_due_at,
    windowEndsAt: r.window_ends_at,
    createdAt: r.created_at,
  };
}

export function recoveryEnabled(): boolean {
  return getSetting('recovery_enabled') !== 'false';
}

/** Start (or restart) the 2h / 20h follow-up for a customer who asked about price. */
export function registerInquiry(recipientId: string, productTitle?: string, now = Date.now()): Inquiry | undefined {
  if (!recoveryEnabled()) return undefined;
  db().prepare("UPDATE inquiries SET status = 'CANCELLED' WHERE recipient_id = ? AND status = 'PENDING'").run(recipientId);
  const result = db()
    .prepare(
      `INSERT INTO inquiries (recipient_id, product_title, next_step, next_due_at, window_ends_at, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    )
    .run(
      recipientId,
      productTitle ?? null,
      now + config.recovery.step1DelayMinutes * MIN,
      now + config.recovery.windowHours * 60 * MIN,
      now
    );
  return toInquiry(db().prepare('SELECT * FROM inquiries WHERE id = ?').get(Number(result.lastInsertRowid)));
}

/** Every customer message reopens Meta's 24h window. */
export function touchWindow(recipientId: string, now = Date.now()): void {
  db()
    .prepare("UPDATE inquiries SET window_ends_at = ? WHERE recipient_id = ? AND status = 'PENDING'")
    .run(now + config.recovery.windowHours * 60 * MIN, recipientId);
}

export function closeInquiry(recipientId: string, status: 'PAID' | 'CANCELLED'): number {
  return db()
    .prepare("UPDATE inquiries SET status = ?, next_due_at = NULL WHERE recipient_id = ? AND status = 'PENDING'")
    .run(status, recipientId).changes as number;
}

export function listInquiries(limit = 200): Inquiry[] {
  return db().prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT ?').all(limit).map(toInquiry);
}

/** Send every follow-up that is due. Runs on a timer; safe to call repeatedly. */
export async function runDueRecoveries(now = Date.now()): Promise<number> {
  const accountId = getSetting('account_id');
  if (!accountId) return 0;
  const due = db()
    .prepare("SELECT * FROM inquiries WHERE status = 'PENDING' AND next_due_at IS NOT NULL AND next_due_at <= ?")
    .all(now)
    .map(toInquiry);

  let sent = 0;
  for (const inq of due) {
    // Outside the 24h window Instagram rejects the message, so stop quietly.
    if (now >= inq.windowEndsAt) {
      db().prepare("UPDATE inquiries SET status = 'EXPIRED', next_due_at = NULL WHERE id = ?").run(inq.id);
      continue;
    }

    const text =
      inq.nextStep === 1
        ? getSetting('recovery_step1_text') || step1Message(inq.productTitle)
        : getSetting('recovery_step2_text') || step2Message(getSetting('discount_code'), getSetting('payment_link'));

    // Claim the step before sending so an overlapping tick cannot send it twice.
    if (inq.nextStep === 1) {
      const step2At = inq.createdAt + config.recovery.step2DelayMinutes * MIN;
      db().prepare('UPDATE inquiries SET next_step = 2, next_due_at = ? WHERE id = ?').run(step2At, inq.id);
    } else {
      db().prepare("UPDATE inquiries SET status = 'DONE', next_step = NULL, next_due_at = NULL WHERE id = ?").run(inq.id);
    }

    try {
      await boxApi.sendMessage(accountId, inq.recipientId, text);
      sent++;
      alerts.recoverySent(inq.recipientId, inq.nextStep ?? 1, inq.productTitle).catch(() => {});
    } catch (err: any) {
      console.warn(`[recovery] step ${inq.nextStep} to ${inq.recipientId} failed: ${err.message}`);
    }
  }
  return sent;
}
