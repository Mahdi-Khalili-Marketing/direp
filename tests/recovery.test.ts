import { describe, it, expect, beforeEach } from 'vitest';
import { registerInquiry, runDueRecoveries, listInquiries, closeInquiry, touchWindow } from '../src/recovery.js';
import { setSetting } from '../src/db.js';
import { config } from '../src/config.js';
import { freshInstall, ACCOUNT } from './helpers.js';

const MIN = 60_000;

describe('cart recovery', () => {
  let mocks: ReturnType<typeof freshInstall>;
  const t0 = Date.UTC(2026, 9, 6, 8, 0);
  beforeEach(() => {
    mocks = freshInstall();
  });

  it('sends the 2h check-in, then the 20h offer, then stops', async () => {
    setSetting('discount_code', 'YALDA10');
    registerInquiry('buyer', 'مانتو کتان', t0);

    expect(await runDueRecoveries(t0 + 60 * MIN)).toBe(0);
    expect(await runDueRecoveries(t0 + config.recovery.step1DelayMinutes * MIN)).toBe(1);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(ACCOUNT, 'buyer', expect.stringContaining('مانتو کتان'));

    expect(await runDueRecoveries(t0 + config.recovery.step2DelayMinutes * MIN)).toBe(1);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(ACCOUNT, 'buyer', expect.stringContaining('YALDA10'));

    expect(await runDueRecoveries(t0 + 23 * 60 * MIN)).toBe(0);
    expect(listInquiries()[0].status).toBe('DONE');
  });

  it('never messages outside Meta 24h window', async () => {
    registerInquiry('late', undefined, t0);
    expect(await runDueRecoveries(t0 + 25 * 60 * MIN)).toBe(0);
    expect(listInquiries()[0].status).toBe('EXPIRED');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('stops when the customer pays', async () => {
    registerInquiry('payer', undefined, t0);
    closeInquiry('payer', 'PAID');
    expect(await runDueRecoveries(t0 + 21 * 60 * MIN)).toBe(0);
  });

  it('a new customer message extends the window', async () => {
    registerInquiry('chatty', undefined, t0);
    await runDueRecoveries(t0 + config.recovery.step1DelayMinutes * MIN);
    touchWindow('chatty', t0 + 10 * 60 * MIN);
    expect(listInquiries()[0].windowEndsAt).toBe(t0 + 34 * 60 * MIN);
  });

  it('can be switched off by the owner', () => {
    setSetting('recovery_enabled', 'false');
    expect(registerInquiry('x', undefined, t0)).toBeUndefined();
  });
});
