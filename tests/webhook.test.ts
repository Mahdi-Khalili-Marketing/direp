import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { processEvent } from '../src/webhook.js';
import { setSetting, getSetting } from '../src/db.js';
import { listInquiries } from '../src/recovery.js';
import { listContacts } from '../src/contacts.js';
import { freshInstall, dm, ACCOUNT } from './helpers.js';
import * as alertsModule from '../src/alerts.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('webhook authentication', () => {
  let mocks: ReturnType<typeof freshInstall>;
  beforeEach(() => {
    mocks = freshInstall();
  });

  it('rejects deliveries without the install key', async () => {
    const res = await request(createApp()).post('/api/webhooks/boxapi').send(dm('u1', 'قیمت؟'));
    expect(res.status).toBe(401);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('accepts the install key and deduplicates BoxAPI retries by event_id', async () => {
    const app = createApp();
    const payload = { ...dm('u1', 'قیمت؟'), event_id: 'evt_fixed' };
    const first = await request(app).post('/api/webhooks/boxapi?key=hook-key').send(payload);
    const retry = await request(app).post('/api/webhooks/boxapi?key=hook-key').send(payload);
    await flush();
    expect(first.body.status).toBe('ok');
    expect(retry.body.status).toBe('duplicate');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('verifies the BoxAPI HMAC signature when a webhook secret is set', async () => {
    setSetting('webhook_secret', 'whsec');
    const app = createApp();
    const body = JSON.stringify(dm('u1', 'سلام'));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec').update(`${ts}.${body}`).digest('hex');

    const good = await request(app)
      .post('/api/webhooks/boxapi')
      .set('Content-Type', 'application/json')
      .set('X-BoxApi-Signature', sig)
      .set('X-BoxApi-Timestamp', ts)
      .send(body);
    expect(good.status).toBe(200);

    const tampered = await request(app)
      .post('/api/webhooks/boxapi')
      .set('Content-Type', 'application/json')
      .set('X-BoxApi-Signature', sig)
      .set('X-BoxApi-Timestamp', ts)
      .send(body.replace('سلام', 'قیمت'));
    expect(tampered.status).toBe(401);

    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = 'sha256=' + crypto.createHmac('sha256', 'whsec').update(`${old}.${body}`).digest('hex');
    const stale = await request(app)
      .post('/api/webhooks/boxapi')
      .set('Content-Type', 'application/json')
      .set('X-BoxApi-Signature', oldSig)
      .set('X-BoxApi-Timestamp', old)
      .send(body);
    expect(stale.status).toBe(401);
  });
});

describe('direct messages', () => {
  let mocks: ReturnType<typeof freshInstall>;
  beforeEach(() => {
    mocks = freshInstall();
  });

  it('answers a price question and starts cart recovery', async () => {
    await processEvent(dm('buyer1', 'سلام قیمت این مدل چنده؟ شمارم 0912 345 6789'));
    expect(mocks.sendMessage).toHaveBeenCalledWith(ACCOUNT, 'buyer1', expect.stringContaining('قیمت'));
    const inquiry = listInquiries().find((i) => i.recipientId === 'buyer1');
    expect(inquiry?.status).toBe('PENDING');
    const contact = listContacts().find((c) => c.igUserId === 'buyer1');
    expect(contact?.stage).toBe('INQUIRY');
    expect(contact?.phone).toBe('09123456789');
  });

  it('never answers its own echoes or other pages', async () => {
    await processEvent(dm('page_ig', 'قیمت'));
    await processEvent(dm('buyer1', 'قیمت', { is_echo: true }));
    await processEvent({ ...dm('buyer1', 'قیمت'), account_id: 'someone-else' });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('alerts the owner on a complaint and replies with an apology only', async () => {
    const alert = vi.spyOn(alertsModule.alerts, 'complaint').mockResolvedValue(true);
    await processEvent(dm('angry', 'سفارشم نرسیده، شکایت میکنم'));
    expect(alert).toHaveBeenCalledWith('angry', expect.any(String));
    expect(mocks.sendMessage).toHaveBeenCalledWith(ACCOUNT, 'angry', expect.stringContaining('پوزش'));
  });

  it('closes the cart and counts an order when a receipt arrives', async () => {
    vi.spyOn(alertsModule.alerts, 'receipt').mockResolvedValue(true);
    await processEvent(dm('buyer2', 'قیمت؟'));
    await processEvent(dm('buyer2', 'واریز کردم'));
    expect(listInquiries().find((i) => i.recipientId === 'buyer2')?.status).toBe('PAID');
    expect(listContacts().find((c) => c.igUserId === 'buyer2')?.totalOrders).toBe(1);
  });

  it('respects the global auto-reply switch', async () => {
    setSetting('auto_reply_enabled', 'false');
    await processEvent(dm('buyer3', 'قیمت؟'));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(listInquiries()).toHaveLength(1);
  });

  it('stores posts from the async list_posts result', async () => {
    const { db } = await import('../src/db.js');
    await processEvent({
      event_type: 'action.list_posts',
      account_id: ACCOUNT,
      data: { result: { data: [{ id: 'p1', caption: 'مانتو', media_type: 'VIDEO', permalink: 'https://instagram.com/p/x' }] } },
    });
    expect((db().prepare('SELECT caption FROM posts WHERE id = ?').get('p1') as any).caption).toBe('مانتو');
    expect(getSetting('last_follow_event')).toBeUndefined();
  });
});
