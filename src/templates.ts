/** Persian cart-recovery messages. The owner can override both in settings. */

export function step1Message(productTitle?: string | null): string {
  return productTitle
    ? `سلام و درود! در مورد «${productTitle}» سوال یا ابهامی دارید؟ با کمال میل در خدمتتون هستیم 😊`
    : 'سلام و درود! برای ثبت سفارش نیاز به راهنمایی دارید؟ با کمال میل پاسخگوی شما هستیم ✨';
}

export function step2Message(discountCode?: string, paymentLink?: string): string {
  const lines = ['موجودی محدوده و ممکنه تا پایان روز تموم بشه.'];
  if (discountCode) lines.push(`🎁 با کد تخفیف ${discountCode} سفارشتون رو ثبت کنید.`);
  lines.push(
    paymentLink
      ? `🔗 لینک ثبت سفارش: ${paymentLink}`
      : 'برای ثبت سفارش کافیه شماره تماس و آدرستون رو همین‌جا بفرستید.'
  );
  return lines.join('\n');
}
