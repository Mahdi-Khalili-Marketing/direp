import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectChatId } from '../src/alerts.js';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({ status, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('chat id detection for Bale / Telegram alerts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the latest private chat from getUpdates on the Bale host', async () => {
    const fetchMock = mockFetch(200, {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111, first_name: 'Old' } } },
        { update_id: 2, message: { chat: { id: 987654321, first_name: 'مریم', last_name: 'اکبری' } } },
      ],
    });
    expect(await detectChatId('bale', 'TOKEN')).toEqual({ chatId: '987654321', name: 'مریم اکبری' });
    expect(fetchMock).toHaveBeenCalledWith('https://tapi.bale.ai/botTOKEN/getUpdates');
  });

  it('uses the Telegram host for Telegram', async () => {
    const fetchMock = mockFetch(200, { ok: true, result: [{ message: { chat: { id: 5 } } }] });
    await detectChatId('telegram', 'T');
    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/botT/getUpdates');
  });

  it('asks the owner to message the bot first when there are no updates', async () => {
    mockFetch(200, { ok: true, result: [] });
    const result = await detectChatId('bale', 'TOKEN');
    expect('error' in result && result.error).toContain('/start');
  });

  it('reports a wrong token clearly (Bale: 400 Token not found, Telegram: 404)', async () => {
    mockFetch(400, { ok: false, error_code: 400, description: 'Bad Request: Token not found' });
    expect(await detectChatId('bale', 'bad')).toEqual({ error: 'توکن ربات اشتباه است' });
    mockFetch(404, { ok: false, error_code: 404, description: 'Not Found' });
    expect(await detectChatId('telegram', 'bad')).toEqual({ error: 'توکن ربات اشتباه است' });
  });
});
