import { describe, it, expect, beforeEach } from 'vitest';
import { detectIntent, replyFor, REPLY_OFF } from '../src/intents.js';
import { openDb, setSetting } from '../src/db.js';

describe('intent detection', () => {
  beforeEach(() => openDb(':memory:'));

  it('detects Persian intents', () => {
    expect(detectIntent('سلام قیمت این مانتو چنده؟')).toBe('PRICE_INQUIRY');
    expect(detectIntent('کد رهگیری سفارشم رو میدین؟')).toBe('ORDER_TRACKING');
    expect(detectIntent('واریز کردم اینم فیش')).toBe('PAYMENT_RECEIPT');
    expect(detectIntent('برای قد ۱۷۰ چه سایزی خوبه')).toBe('SIZE_INQUIRY');
    expect(detectIntent('سلام وقت بخیر')).toBe('GENERAL');
  });

  it('understands Finglish and Arabic-keyboard letters', () => {
    expect(detectIntent('salam gheymatesh chande?')).toBe('PRICE_INQUIRY');
    expect(detectIntent('قيمت')).toBe('PRICE_INQUIRY'); // Arabic yeh
  });

  it('puts complaints first so angry customers never get a sales reply', () => {
    expect(detectIntent('قیمتش رو گرفتید ولی سفارشم نرسیده، شکایت میکنم')).toBe('COMPLAINT');
  });

  it('matches Latin keywords as whole words only', () => {
    expect(detectIntent('poster')).toBe('GENERAL');
    expect(detectIntent('post shode?')).toBe('ORDER_TRACKING');
  });

  it('lets the owner override or switch off a reply', () => {
    setSetting('reply_PRICE_INQUIRY', 'قیمت در لینک بایو');
    expect(replyFor('PRICE_INQUIRY')).toBe('قیمت در لینک بایو');
    setSetting('reply_PRICE_INQUIRY', REPLY_OFF);
    expect(replyFor('PRICE_INQUIRY')).toBe('');
    expect(replyFor('GENERAL')).toBe('');
  });
});
