import { db, getSetting } from './db.js';
import { boxApi, Button } from './boxapi.js';
import { config } from './config.js';
import { upsertContact } from './contacts.js';

export interface Rule {
  id: number;
  keyword: string;
  matchType: 'CONTAINS' | 'EXACT' | 'ANY';
  commentReplies: string[];
  dmText: string;
  requireFollow: boolean;
  unfollowedDm: string | null;
  buttonTitle: string | null;
  buttonUrl: string | null;
  isActive: boolean;
}

export interface CommentEvent {
  id: string;
  text?: string;
  from: { id: string; username?: string };
  media?: { id: string };
}

const DEFAULT_UNFOLLOWED_DM = 'سلام! برای دریافت قیمت و تخفیف، اول پیج رو فالو کنید و دوباره کامنت بذارید 🌺';

function toRule(row: any): Rule {
  return {
    id: row.id,
    keyword: row.keyword,
    matchType: row.match_type,
    commentReplies: JSON.parse(row.comment_replies || '[]'),
    dmText: row.dm_text,
    requireFollow: Boolean(row.require_follow),
    unfollowedDm: row.unfollowed_dm,
    buttonTitle: row.button_title,
    buttonUrl: row.button_url,
    isActive: Boolean(row.is_active),
  };
}

export function listRules(): Rule[] {
  return db().prepare('SELECT * FROM rules ORDER BY id DESC').all().map(toRule);
}

export function getRule(id: number): Rule | undefined {
  const row = db().prepare('SELECT * FROM rules WHERE id = ?').get(id);
  return row ? toRule(row) : undefined;
}

export function saveRule(input: Omit<Rule, 'id' | 'isActive'> & { id?: number; isActive?: boolean }): Rule {
  const values = [
    input.keyword.trim(),
    input.matchType,
    JSON.stringify(input.commentReplies.map((r) => r.trim()).filter(Boolean)),
    input.dmText.trim(),
    input.requireFollow ? 1 : 0,
    input.unfollowedDm?.trim() || null,
    input.buttonTitle?.trim() || null,
    input.buttonUrl?.trim() || null,
    input.isActive === false ? 0 : 1,
  ] as const;
  if (input.id) {
    db()
      .prepare(
        `UPDATE rules SET keyword=?, match_type=?, comment_replies=?, dm_text=?, require_follow=?,
         unfollowed_dm=?, button_title=?, button_url=?, is_active=? WHERE id=?`
      )
      .run(...values, input.id);
    return getRule(input.id)!;
  }
  const result = db()
    .prepare(
      `INSERT INTO rules (keyword, match_type, comment_replies, dm_text, require_follow,
       unfollowed_dm, button_title, button_url, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(...values, new Date().toISOString());
  return getRule(Number(result.lastInsertRowid))!;
}

export function deleteRule(id: number): boolean {
  return db().prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
}

export function toggleRule(id: number): boolean {
  return db().prepare('UPDATE rules SET is_active = 1 - is_active WHERE id = ?').run(id).changes > 0;
}

function normalize(text: string): string {
  return text.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').toLowerCase().trim();
}

/** A rule's keyword field may hold several keywords separated by commas (, or ،). */
export function ruleMatches(rule: Rule, commentText: string): boolean {
  if (!rule.isActive) return false;
  if (rule.matchType === 'ANY') return true;
  const text = normalize(commentText);
  const keywords = rule.keyword.split(/[,،]/).map(normalize).filter(Boolean);
  return keywords.some((k) => (rule.matchType === 'EXACT' ? text === k : text.includes(k)));
}

function buttonsFor(rule: Rule): Button[] | undefined {
  return rule.buttonTitle && rule.buttonUrl ? [{ type: 'web_url', title: rule.buttonTitle, url: rule.buttonUrl }] : undefined;
}

async function sendRuleDm(accountId: string, rule: Rule, commentId: string, following: boolean) {
  if (following) {
    await boxApi.privateReply(accountId, commentId, rule.dmText, buttonsFor(rule));
  } else {
    await boxApi.privateReply(accountId, commentId, rule.unfollowedDm || DEFAULT_UNFOLLOWED_DM);
  }
}

export async function handleComment(accountId: string, comment: CommentEvent): Promise<void> {
  const pageIgId = getSetting('page_ig_user_id');
  if (!comment?.id || !comment.from?.id || comment.from.id === pageIgId) return;

  upsertContact(comment.from.id, { username: comment.from.username });
  if (comment.media?.id) {
    db().prepare('UPDATE posts SET comments_seen = comments_seen + 1 WHERE id = ?').run(comment.media.id);
  }

  const rule = listRules().find((r) => ruleMatches(r, comment.text || ''));
  if (!rule) return;

  if (rule.commentReplies.length) {
    // Varying the public reply keeps Instagram from flagging identical repeats.
    const reply = rule.commentReplies[Math.floor(Math.random() * rule.commentReplies.length)];
    await boxApi.replyComment(accountId, comment.id, reply).catch((err) =>
      console.warn(`[rules] comment reply failed: ${err.message}`)
    );
  }

  if (!rule.requireFollow) {
    await sendRuleDm(accountId, rule, comment.id, true);
    return;
  }

  // follow_status is asynchronous: park the comment until the webhook answers.
  db()
    .prepare('INSERT INTO follow_checks (comment_id, commenter_id, rule_id, created_at) VALUES (?, ?, ?, ?)')
    .run(comment.id, comment.from.id, rule.id, Date.now());
  await boxApi.requestFollowStatus(accountId, comment.from.id);
}

/** Called when BoxAPI delivers a follow_status result. */
export async function handleFollowResult(accountId: string, customerId: string, isFollowing: boolean): Promise<number> {
  const waiting = db()
    .prepare("SELECT id, comment_id, rule_id FROM follow_checks WHERE status = 'WAITING' AND commenter_id = ?")
    .all(customerId) as { id: number; comment_id: string; rule_id: number }[];
  for (const check of waiting) {
    db().prepare('UPDATE follow_checks SET status = ? WHERE id = ?').run(isFollowing ? 'FOLLOWING' : 'NOT_FOLLOWING', check.id);
    const rule = getRule(check.rule_id);
    if (rule) await sendRuleDm(accountId, rule, check.comment_id, isFollowing);
  }
  return waiting.length;
}

/**
 * If BoxAPI never answers, the commenter would get nothing. After the timeout
 * we fail open and send the normal DM: a lost sale costs more than one
 * non-follower seeing a price.
 */
export async function expireFollowChecks(accountId: string, now = Date.now()): Promise<number> {
  const cutoff = now - config.followCheckTimeoutSeconds * 1000;
  const stale = db()
    .prepare("SELECT id, comment_id, rule_id FROM follow_checks WHERE status = 'WAITING' AND created_at < ?")
    .all(cutoff) as { id: number; comment_id: string; rule_id: number }[];
  for (const check of stale) {
    db().prepare("UPDATE follow_checks SET status = 'TIMEOUT' WHERE id = ?").run(check.id);
    const rule = getRule(check.rule_id);
    if (rule) await sendRuleDm(accountId, rule, check.comment_id, true).catch(() => {});
  }
  return stale.length;
}
