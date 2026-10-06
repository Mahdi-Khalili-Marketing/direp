import { db } from './db.js';

export type Stage = 'NEW' | 'INQUIRY' | 'PAID' | 'COMPLAINT';

export interface Contact {
  igUserId: string;
  username: string | null;
  phone: string | null;
  stage: Stage;
  totalOrders: number;
  lastMessageAt: number | null;
}

export function upsertContact(
  igUserId: string,
  patch: { username?: string; stage?: Stage; lastMessageAt?: number; phone?: string } = {}
): void {
  db()
    .prepare(
      `INSERT INTO contacts (ig_user_id, username, phone, stage, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ig_user_id) DO UPDATE SET
         username = COALESCE(excluded.username, contacts.username),
         phone = COALESCE(excluded.phone, contacts.phone),
         stage = CASE WHEN ? IS NULL THEN contacts.stage ELSE excluded.stage END,
         last_message_at = COALESCE(excluded.last_message_at, contacts.last_message_at)`
    )
    .run(
      igUserId,
      patch.username ?? null,
      patch.phone ?? null,
      patch.stage ?? 'NEW',
      patch.lastMessageAt ?? null,
      new Date().toISOString(),
      patch.stage ?? null
    );
}

export function recordOrder(igUserId: string): void {
  upsertContact(igUserId, { stage: 'PAID' });
  db().prepare('UPDATE contacts SET total_orders = total_orders + 1 WHERE ig_user_id = ?').run(igUserId);
}

export function listContacts(limit = 200): Contact[] {
  return (
    db().prepare('SELECT * FROM contacts ORDER BY COALESCE(last_message_at, 0) DESC LIMIT ?').all(limit) as any[]
  ).map((r) => ({
    igUserId: r.ig_user_id,
    username: r.username,
    phone: r.phone,
    stage: r.stage,
    totalOrders: r.total_orders,
    lastMessageAt: r.last_message_at,
  }));
}

/** Iranian mobile numbers customers type into DMs, so the owner can call them back. */
export function extractPhone(text: string): string | undefined {
  const digits = text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const match = digits.match(/(?:\+98|0098|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}/);
  return match ? match[0].replace(/[\s-]/g, '') : undefined;
}
