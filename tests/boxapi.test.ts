import { describe, it, expect, vi } from 'vitest';
import { BoxApiClient } from '../src/boxapi.js';

function client(response: unknown = { success: true }, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => response });
  return { fetchMock, api: new BoxApiClient(() => 'key-1', 'https://api.sendbox.chat/api/v1', false, fetchMock as any) };
}

describe('BoxAPI client (paths and fields from the official docs)', () => {
  it('sends DMs with X-Api-Key to /service/actions/send_message', async () => {
    const { fetchMock, api } = client();
    await api.sendMessage('acc', 'user', 'سلام');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sendbox.chat/api/v1/service/actions/send_message');
    expect(init.headers['X-Api-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual({ account_id: 'acc', recipient_id: 'user', message: 'سلام' });
  });

  it('uses customer_id for follow_status and reply_comment for public replies', async () => {
    const { fetchMock, api } = client();
    await api.requestFollowStatus('acc', 'cust');
    await api.replyComment('acc', 'c1', 'ممنون');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/service\/actions\/follow_status$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ account_id: 'acc', customer_id: 'cust' });
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/service\/actions\/reply_comment$/);
  });

  it('raises BoxAPI error messages', async () => {
    const { api } = client({ success: false, message: 'X-Api-Key header is required.' }, 401);
    await expect(api.accounts()).rejects.toThrow('X-Api-Key header is required.');
  });

  it('refuses to call without a key', async () => {
    const api = new BoxApiClient(() => undefined);
    await expect(api.serviceInfo()).rejects.toThrow('کلید BoxAPI');
  });
});
