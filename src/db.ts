import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Loaded through require because test bundlers (Vite) do not resolve node:sqlite yet.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'CONTAINS',
  comment_replies TEXT NOT NULL DEFAULT '[]',
  dm_text TEXT NOT NULL,
  require_follow INTEGER NOT NULL DEFAULT 0,
  unfollowed_dm TEXT,
  button_title TEXT,
  button_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  ig_user_id TEXT PRIMARY KEY,
  username TEXT,
  phone TEXT,
  stage TEXT NOT NULL DEFAULT 'NEW',
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,
  product_title TEXT,
  quoted_price INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING',
  next_step INTEGER,
  next_due_at INTEGER,
  window_ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inquiries_due ON inquiries (status, next_due_at);

CREATE TABLE IF NOT EXISTS follow_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL,
  commenter_id TEXT NOT NULL,
  rule_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_waiting ON follow_checks (status, commenter_id);

CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  caption TEXT,
  media_type TEXT,
  media_url TEXT,
  permalink TEXT,
  posted_at TEXT,
  comments_seen INTEGER NOT NULL DEFAULT 0
);
`;

let instance: DatabaseSync | null = null;

/** Open (and migrate) the database. Pass ':memory:' in tests. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  instance = db;
  return db;
}

export function db(): DatabaseSync {
  if (!instance) throw new Error('Database not opened; call openDb() first');
  return instance;
}

export function getSetting(key: string): string | undefined {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string | undefined | null): void {
  if (value === undefined || value === null || value === '') {
    db().prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
