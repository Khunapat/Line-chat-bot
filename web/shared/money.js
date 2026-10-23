/**
 * Money and billing-cycle wording shared by the bot and the web app.
 * Amounts are shown exactly as stored; no conversion between currencies.
 */

/** "฿419", "฿149.50", "$9.99"; Thai or English number style. */
export function formatMoney(amount, currency = 'THB', lang = 'th') {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '';
  const code = /^[A-Z]{3}$/.test(currency || '') ? currency : 'THB';
  const whole = Math.abs(n % 1) < 1e-9;
  try {
    return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'th-TH', {
      style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(whole ? 0 : 2)} ${code}`;
  }
}

export const CYCLES = ['monthly', 'yearly', 'weekly', 'unknown'];

/** "฿419/เดือน", "US$99/year", or just the amount when the cycle is unknown. */
export function formatPrice(amount, currency, cycle, lang = 'th') {
  const money = formatMoney(amount, currency, lang);
  if (!money) return '';
  const per = {
    th: { monthly: '/เดือน', yearly: '/ปี', weekly: '/สัปดาห์' },
    en: { monthly: '/month', yearly: '/year', weekly: '/week' },
  }[lang === 'en' ? 'en' : 'th'][cycle] || '';
  return `${money}${per}`;
}
