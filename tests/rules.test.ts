import { describe, it, expect, beforeEach } from 'vitest';
import { processEvent } from '../src/webhook.js';
import { saveRule, ruleMatches, listRules, expireFollowChecks } from '../src/rules.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { freshInstall, comment, ACCOUNT } from './helpers.js';

const baseRule = {
  keyword: 'قیمت، price',
  matchType: 'CONTAINS' as const,
  commentReplies: ['دایرکت شد 🌸'],
  dmText: 'قیمت این مدل ۶۸۰ هزار تومان',
  requireFollow: false,
  unfollowedDm: 'اول پیج رو فالو کنید',
  buttonTitle: 'خرید',
  buttonUrl: 'https://shop.example/checkout',
};

describe('comment to DM', () => {
  let mocks: ReturnType<typeof freshInstall>;
  beforeEach(() => {
    mocks = freshInstall();
  });

  it('matches any of several comma-separated keywords', () => {
    const rule = saveRule(baseRule);
    expect(ruleMatches(rule, 'Price please')).toBe(true);
    expect(ruleMatches(rule, 'قيمتش؟')).toBe(true); // Arabic yeh normalised
    expect(ruleMatches(rule, 'خیلی قشنگه')).toBe(false);
  });

  it('replies publicly and sends the DM with a link button', async () => {
    saveRule(baseRule);
    await processEvent(comment('fan1', 'قیمت لطفا'));
    expect(mocks.replyComment).toHaveBeenCalledWith(ACCOUNT, 'c1', 'دایرکت شد 🌸');
    expect(mocks.privateReply).toHaveBeenCalledWith(ACCOUNT, 'c1', baseRule.dmText, [
      { type: 'web_url', title: 'خرید', url: 'https://shop.example/checkout' },
    ]);
  });

  it('ignores inactive rules and the page commenting on itself', async () => {
    const rule = saveRule(baseRule);
    await processEvent(comment('page_ig', 'قیمت'));
    db().prepare('UPDATE rules SET is_active = 0 WHERE id = ?').run(rule.id);
    await processEvent(comment('fan1', 'قیمت'));
    expect(mocks.privateReply).not.toHaveBeenCalled();
  });
});

describe('Follow-Gate (async follow_status)', () => {
  let mocks: ReturnType<typeof freshInstall>;
  beforeEach(() => {
    mocks = freshInstall();
    saveRule({ ...baseRule, requireFollow: true });
  });

  it('waits for the webhook result before sending anything', async () => {
    await processEvent(comment('fan1', 'قیمت', 'c9'));
    expect(mocks.requestFollowStatus).toHaveBeenCalledWith(ACCOUNT, 'fan1');
    expect(mocks.privateReply).not.toHaveBeenCalled();

    await processEvent({
      event_type: 'action.follow_status',
      account_id: ACCOUNT,
      data: { result: { customer_id: 'fan1', is_following: true } },
    });
    expect(mocks.privateReply).toHaveBeenCalledWith(ACCOUNT, 'c9', baseRule.dmText, expect.any(Array));
  });

  it('understands the real BoxAPI follow_status payload', async () => {
    await processEvent(comment('29171758199107756', 'direp قیمت', '18165105577489597'));
    // Captured from a live delivery on 2026-10-06.
    await processEvent({
      event_id: 'action_follow_status_a9d28af6',
      event_type: 'action.follow_status',
      account_id: ACCOUNT,
      data: {
        request: { account_id: ACCOUNT, customer_id: '29171758199107756' },
        success: true,
        result: { is_user_follow_business: false, customer_id: '29171758199107756' },
        error: null,
      },
    });
    expect(mocks.privateReply).toHaveBeenCalledWith(ACCOUNT, '18165105577489597', 'اول پیج رو فالو کنید');
  });

  it('asks non-followers to follow first', async () => {
    await processEvent(comment('fan2', 'قیمت', 'c10'));
    await processEvent({
      event_type: 'action.follow_status',
      account_id: ACCOUNT,
      data: { customer_id: 'fan2', is_following: false },
    });
    expect(mocks.privateReply).toHaveBeenCalledWith(ACCOUNT, 'c10', 'اول پیج رو فالو کنید');
  });

  it('fails open with the normal DM if BoxAPI never answers', async () => {
    await processEvent(comment('fan3', 'قیمت', 'c11'));
    const later = Date.now() + (config.followCheckTimeoutSeconds + 1) * 1000;
    expect(await expireFollowChecks(ACCOUNT, later)).toBe(1);
    expect(mocks.privateReply).toHaveBeenCalledWith(ACCOUNT, 'c11', baseRule.dmText, expect.any(Array));
    expect(await expireFollowChecks(ACCOUNT, later)).toBe(0);
  });

  it('keeps rules in the database', () => {
    expect(listRules()).toHaveLength(1);
  });
});
