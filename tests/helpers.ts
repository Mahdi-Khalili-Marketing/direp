import { vi } from 'vitest';
import { openDb, setSetting } from '../src/db.js';
import { boxApi } from '../src/boxapi.js';

export const ACCOUNT = '11111111-2222-3333-4444-555555555555';

/** Fresh in-memory database with a connected page and every BoxAPI call mocked. */
export function freshInstall() {
  openDb(':memory:');
  setSetting('boxapi_key', 'test-key');
  setSetting('account_id', ACCOUNT);
  setSetting('page_ig_user_id', 'page_ig');
  setSetting('webhook_key', 'hook-key');
  vi.restoreAllMocks();
  return {
    sendMessage: vi.spyOn(boxApi, 'sendMessage').mockResolvedValue({ success: true }),
    replyComment: vi.spyOn(boxApi, 'replyComment').mockResolvedValue({ success: true }),
    privateReply: vi.spyOn(boxApi, 'privateReply').mockResolvedValue({ success: true }),
    requestFollowStatus: vi.spyOn(boxApi, 'requestFollowStatus').mockResolvedValue({ success: true }),
  };
}

export const dm = (senderId: string, text: string, extra: Record<string, unknown> = {}) => ({
  event_id: `evt_${Math.random()}`,
  event_type: 'messaging',
  account_id: ACCOUNT,
  data: { sender: { id: senderId }, recipient: { id: 'page_ig' }, message: { mid: 'm1', text, ...extra } },
});

export const comment = (fromId: string, text: string, commentId = 'c1') => ({
  event_id: `evt_${Math.random()}`,
  event_type: 'comments',
  account_id: ACCOUNT,
  data: { id: commentId, text, from: { id: fromId, username: 'sara' }, media: { id: 'post1' } },
});
