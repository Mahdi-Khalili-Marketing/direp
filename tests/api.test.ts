import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb, getSetting } from '../src/db.js';
import { normalizePhone } from '../src/auth.js';
import { boxApi } from '../src/boxapi.js';

describe('setup, login and settings', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    openDb(':memory:');
    vi.restoreAllMocks();
    app = createApp();
  });

  async function setup() {
    const res = await request(app).post('/api/setup').send({ phone: '۰۹۱۲ ۰۰۰ ۰۰۰۱', name: 'دیبا', password: 'longpassword' });
    return res.body.token as string;
  }

  it('normalizes Iranian mobile numbers', () => {
    expect(normalizePhone('09120000001')).toBe('+989120000001');
    expect(normalizePhone('+98 912 000 0001')).toBe('+989120000001');
    expect(normalizePhone('00989120000001')).toBe('+989120000001');
    expect(normalizePhone('12345')).toBe('');
  });

  it('allows exactly one owner per install', async () => {
    expect((await request(app).get('/api/status')).body.setupDone).toBe(false);
    expect(await setup()).toMatch(/^[0-9a-f]{64}$/);
    const again = await request(app).post('/api/setup').send({ phone: '09350000000', name: 'x', password: 'longpassword' });
    expect(again.status).toBe(409);
    expect(getSetting('webhook_key')).toMatch(/^[0-9a-f]{48}$/);
  });

  it('logs in with any phone format and rejects wrong passwords', async () => {
    await setup();
    expect((await request(app).post('/api/login').send({ phone: '+989120000001', password: 'longpassword' })).status).toBe(200);
    expect((await request(app).post('/api/login').send({ phone: '09120000001', password: 'wrong-pass' })).status).toBe(401);
  });

  it('protects every dashboard endpoint', async () => {
    for (const path of ['/api/settings', '/api/rules', '/api/contacts', '/api/inquiries', '/api/stats']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('never returns the BoxAPI key, only a hint, and shows the keyed webhook URL', async () => {
    const token = await setup();
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).put('/api/settings').set(auth).send({ boxApiKey: 'secret-key-9876' });
    const res = await request(app).get('/api/settings').set(auth);
    expect(JSON.stringify(res.body)).not.toContain('secret-key-9876');
    expect(res.body.boxApiKeyHint).toBe('••••9876');
    expect(res.body.webhookUrl).toContain(`/api/webhooks/boxapi?key=${getSetting('webhook_key')}`);
  });

  it('only lets the owner pick a page that exists in their BoxAPI account', async () => {
    const token = await setup();
    const auth = { Authorization: `Bearer ${token}` };
    vi.spyOn(boxApi, 'accounts').mockResolvedValue({
      success: true,
      data: [{ id: 'acc-1', username: 'diba_style', instagram_user_id: '1784' }],
    });
    expect((await request(app).post('/api/page').set(auth).send({ accountId: 'acc-x' })).status).toBe(404);
    const ok = await request(app).post('/api/page').set(auth).send({ accountId: 'acc-1' });
    expect(ok.body.username).toBe('diba_style');
    expect(getSetting('page_ig_user_id')).toBe('1784');
  });

  it('validates rules at the boundary', async () => {
    const token = await setup();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).post('/api/rules').set(auth).send({ keyword: 'قیمت' })).status).toBe(400);
    expect(
      (await request(app).post('/api/rules').set(auth).send({ keyword: 'قیمت', dmText: 'x', buttonUrl: 'javascript:alert(1)' })).status
    ).toBe(400);
    const created = await request(app).post('/api/rules').set(auth).send({ keyword: 'قیمت', dmText: 'سلام' });
    expect(created.status).toBe(201);
  });

  it('changing the password signs out old sessions', async () => {
    const token = await setup();
    const res = await request(app).post('/api/password').set({ Authorization: `Bearer ${token}` }).send({ current: 'longpassword', next: 'newpassword1' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/settings').set({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await request(app).get('/api/settings').set({ Authorization: `Bearer ${res.body.token}` })).status).toBe(200);
  });
});
