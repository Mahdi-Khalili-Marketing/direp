import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';

const SESSION_DAYS = 30;

export interface Owner {
  phone: string;
  name: string;
}

/** Iranian mobile in E.164 (+989xxxxxxxxx); accepts 0912..., 98912..., Persian/Arabic digits. */
export function normalizePhone(raw: string): string {
  const digits = String(raw)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, '');
  if (/^09\d{9}$/.test(digits)) return `+98${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `+98${digits}`;
  if (/^989\d{9}$/.test(digits)) return `+${digits}`;
  if (/^00989\d{9}$/.test(digits)) return `+${digits.slice(2)}`;
  return '';
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function getOwner(): Owner | undefined {
  return db().prepare('SELECT phone, name FROM owner WHERE id = 1').get() as Owner | undefined;
}

/** First-run only: this install belongs to whoever creates the single owner account. */
export function createOwner(phone: string, name: string, password: string): Owner {
  if (getOwner()) throw new Error('OWNER_EXISTS');
  db()
    .prepare('INSERT INTO owner (id, phone, name, password_hash, created_at) VALUES (1, ?, ?, ?, ?)')
    .run(phone, name, hashPassword(password), new Date().toISOString());
  return { phone, name };
}

export function checkLogin(phone: string, password: string): boolean {
  const row = db().prepare('SELECT phone, password_hash FROM owner WHERE id = 1').get() as
    | { phone: string; password_hash: string }
    | undefined;
  // Always run scrypt so a wrong phone and a wrong password take the same time.
  const ok = verifyPassword(password, row?.password_hash || hashPassword('timing-equaliser'));
  return Boolean(row && row.phone === phone && ok);
}

export function changePassword(current: string, next: string): boolean {
  const row = db().prepare('SELECT password_hash FROM owner WHERE id = 1').get() as { password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) return false;
  db().prepare('UPDATE owner SET password_hash = ? WHERE id = 1').run(hashPassword(next));
  db().prepare('DELETE FROM sessions').run();
  return true;
}

/** Sessions are random tokens; only their SHA-256 is stored. */
export function createSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  db()
    .prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)')
    .run(sha256(token), Date.now() + SESSION_DAYS * 86400_000);
  return token;
}

export function destroySession(token: string): void {
  db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function validSession(token: string): boolean {
  const row = db().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { expires_at: number }
    | undefined;
  return Boolean(row && row.expires_at > Date.now());
}

export function bearer(req: Request): string {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token || !validSession(token)) {
    return res.status(401).json({ error: 'لطفاً دوباره وارد شوید' });
  }
  next();
}

/** Small in-memory limiter for login and setup; enough for a single-shop install. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'تلاش‌ها بیش از حد مجاز است. چند دقیقه دیگر دوباره امتحان کنید.' });
    }
    next();
  };
}
