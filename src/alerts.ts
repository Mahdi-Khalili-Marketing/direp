import { getSetting } from './db.js';

/**
 * Merchant alerts through a Telegram or Bale bot. Bale's bot API mirrors
 * Telegram's, so only the host differs. Bale works inside Iran without a VPN.
 */
const HOSTS = {
  telegram: 'https://api.telegram.org',
  bale: 'https://tapi.bale.ai',
} as const;

export type AlertChannel = keyof typeof HOSTS;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendAlert(
  html: string,
  override?: { channel: AlertChannel; botToken: string; chatId: string }
): Promise<boolean> {
  const channel = (override?.channel || getSetting('alert_channel')) as AlertChannel | undefined;
  const token = override?.botToken || getSetting('alert_bot_token');
  const chatId = override?.chatId || getSetting('alert_chat_id');
  if (!channel || !(channel in HOSTS) || !token || !chatId) return false;

  try {
    const res = await fetch(`${HOSTS[channel]}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!body.ok) console.warn(`[alerts] ${channel} rejected message: ${body.description || res.status}`);
    return Boolean(body.ok);
  } catch (err: any) {
    console.warn(`[alerts] ${channel} unreachable: ${err.message}`);
    return false;
  }
}

export const alerts = {
  complaint(customerId: string, message: string) {
    return sendAlert(
      `⚠️ <b>شکایت یا پیام فوری مشتری</b>\n\n👤 مشتری: <code>${escapeHtml(customerId)}</code>\n💬 <i>${escapeHtml(message)}</i>\n\n🚨 لطفاً خودتان در دایرکت جواب بدهید.`
    );
  },
  receipt(customerId: string, message: string) {
    return sendAlert(
      `🧾 <b>رسید پرداخت دریافت شد</b>\n\n👤 مشتری: <code>${escapeHtml(customerId)}</code>\n💬 <i>${escapeHtml(message)}</i>\n\nلطفاً واریز را بررسی و سفارش را ثبت کنید.`
    );
  },
  recoverySent(customerId: string, step: number, productTitle?: string | null) {
    return sendAlert(
      `🛒 <b>یادآوری سبد خرید (مرحله ${step === 1 ? '۱' : '۲'}) ارسال شد</b>\n\n👤 مشتری: <code>${escapeHtml(customerId)}</code>${
        productTitle ? `\n📦 محصول: ${escapeHtml(productTitle)}` : ''
      }`
    );
  },
};
