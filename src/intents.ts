import { getSetting } from './db.js';

export type Intent =
  | 'PRICE_INQUIRY'
  | 'SIZE_INQUIRY'
  | 'ORDER_TRACKING'
  | 'PAYMENT_RECEIPT'
  | 'COMPLAINT'
  | 'GENERAL';

/**
 * Keyword lists in Persian script plus common Finglish spellings, because many
 * Iranian shoppers type Persian with Latin letters ("gheymat chande?").
 * Order matters: complaints win over everything so an angry customer is never
 * answered by a cheerful bot.
 */
const KEYWORDS: [Intent, string[]][] = [
  ['COMPLAINT', ['کلاهبردار', 'شکایت', 'پلیس فتا', 'پولم', 'پس بده', 'دزد', 'نرسیده', 'افتضاح', 'kolahbardar', 'shekayat']],
  ['PAYMENT_RECEIPT', ['واریز شد', 'واریز کردم', 'فیش', 'پرداخت شد', 'پرداخت کردم', 'کارت به کارت', 'رسید', 'variz', 'fish', 'pardakht']],
  ['PRICE_INQUIRY', ['قیمت', 'چنده', 'چند', 'هزینه', 'تخفیف', 'gheymat', 'ghimat', 'qeymat', 'chande', 'chand']],
  ['ORDER_TRACKING', ['کد رهگیری', 'رهگیری', 'تیپاکس', 'پست', 'کی میرسه', 'بستم', 'ارسال', 'rahgiri', 'tipax', 'post']],
  ['SIZE_INQUIRY', ['سایز', 'قد', 'وزن', 'اندازه', 'تنخور', 'رنگ', 'size', 'rang']],
];

export const DEFAULT_REPLIES: Record<Intent, string> = {
  COMPLAINT: 'سلام و احترام، پوزش بابت مشکل پیش آمده. پیام شما به مدیر فروشگاه ارجاع داده شد و در اولین فرصت پیگیری می‌شود.',
  PAYMENT_RECEIPT: 'سلام! رسید شما دریافت شد و بعد از بررسی، سفارشتون ثبت و کد رهگیری براتون ارسال می‌شه 🌸',
  PRICE_INQUIRY: 'سلام! ممنون از پیامتون 🌸 قیمت و جزئیات این محصول رو همین‌جا براتون می‌فرستیم. اگر سایز یا رنگ خاصی مدنظرتونه بفرمایید.',
  ORDER_TRACKING: 'سلام! برای پیگیری سفارش، لطفاً شماره موبایلی که با آن سفارش دادید رو بفرستید.',
  SIZE_INQUIRY: 'سلام! اگر قد و وزنتون رو بفرمایید، دقیق راهنماییتون می‌کنیم کدوم سایز مناسبه 🌺',
  GENERAL: '',
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ')
    .trim();
}

export function detectIntent(text: string): Intent {
  const cleaned = normalize(text);
  if (!cleaned) return 'GENERAL';
  for (const [intent, words] of KEYWORDS) {
    if (words.some((w) => matches(cleaned, normalize(w)))) return intent;
  }
  return 'GENERAL';
}

/** Latin keywords must match whole words ("post" must not fire on "poster"). */
function matches(text: string, word: string): boolean {
  if (/[؀-ۿ]/.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text);
}

/** Stored when the owner turns an auto-reply off (an empty setting means "use the default"). */
export const REPLY_OFF = '__off__';

/** The owner's reply for an intent, or the default. Empty means "do not auto-reply". */
export function replyFor(intent: Intent): string {
  const custom = getSetting(`reply_${intent}`);
  if (custom === REPLY_OFF) return '';
  return custom !== undefined ? custom : DEFAULT_REPLIES[intent];
}

export function escalates(intent: Intent): boolean {
  return intent === 'COMPLAINT';
}
