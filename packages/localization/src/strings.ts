/**
 * The bilingual string table.
 *
 * `04 UX UI/English Strings.md` and `04 UX UI/Amharic Strings.md` are the
 * authoritative sources; this file is their machine-readable form, and
 * `tests/ui/localization.test.ts` fails if the two drift apart.
 *
 * ## Amharic status
 *
 * Every Amharic value here is a **draft**. It carries the same warning the
 * vault note carries — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION — and
 * none of it has been through that review.
 *
 * Fourteen keys have **no Amharic at all**: the screen titles and
 * `support.response.notice`. They are absent rather than machine-translated,
 * because an unreviewed guess that looks finished is worse than a visible gap.
 * `translate` falls back to English and says that it did.
 */

export const LOCALES = ['en', 'am'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** English is complete by definition: it is the source language. */
export const EN = Object.freeze({
  'sale.action.sell_airtime': 'Sell airtime',
  'sale.amount.select': 'Select amount',
  'sale.confirm.action': 'Confirm sale',
  'status.processing': 'Processing',
  'status.pending': 'Transaction pending',
  'status.pending.do_not_retry': 'Do not retry yet',
  'status.successful': 'Transaction successful',
  'status.failed': 'Transaction failed',
  'status.under_review': 'Under review',
  'status.provider_unavailable': 'Provider temporarily unavailable',
  'status.sales_unavailable': 'Sales temporarily unavailable',
  'status.no_charge': 'No charge was made',
  'balance.available': 'Available balance',
  'balance.reserved': 'Reserved balance',
  'balance.under_review': 'Under review balance',
  'commission.net': 'Net commission',
  'receipt.reprint': 'Reprint receipt',
  'transaction.id': 'Transaction ID',
  'support.contact': 'Contact support',
  'mode.training': 'Training mode — no real value',
  'status.pending.message': 'This transaction is still being checked. Do not retry yet.',
  'status.under_review.message':
    'This transaction is being reviewed. Your balance is protected while we check with the provider.',
  'status.failed.message': 'This sale did not go through. No charge was made.',
  'status.provider_unavailable.message':
    'Airtime is temporarily unavailable from this provider. No charge was made. Other services are still working.',
  'status.offline.message':
    'Sales are temporarily unavailable. You can still view history, reports and support.',
  'receipt.reprint.notice': 'This is a reprint. It is not a new sale.',
  'support.response.notice':
    'We will give you a first answer straight away and a final answer within 24 hours.',
  'funding.simulated.notice': 'This is a simulated funding submission. No real money is involved.',
  'error.validation.recipient': 'Check the phone number and try again.',
  'error.balance.insufficient': 'Not enough available balance for this sale.',
  'error.permission.denied': 'Your role does not allow this action.',
  'error.session.expired': 'Your session has ended. Sign in again. Nothing was lost.',
  'error.printer.failed': 'The receipt did not print. The sale is complete — you can reprint it.',
  'error.duplicate.blocked': 'This sale is already in progress. Do not start it again.',
  'screen.login': 'Sign in',
  'screen.home': 'Home',
  'screen.provider_select': 'Select network',
  'screen.amount_select': 'Select amount',
  'screen.recipient': 'Confirm number',
  'screen.confirm': 'Confirm sale',
  'screen.balance': 'Balance',
  'screen.search': 'Find transaction',
  'screen.details': 'Transaction details',
  'screen.reports': 'Reports',
  'screen.funding': 'Add funds',
  'screen.support': 'Support',
  'screen.admin_queue': 'Review queue',
});

export type MessageKey = keyof typeof EN;

export const MESSAGE_KEYS = Object.freeze(Object.keys(EN) as readonly MessageKey[]);

/**
 * Draft Amharic. **REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION.**
 *
 * Partial on purpose — see the file header.
 */
export const AM: Readonly<Partial<Record<MessageKey, string>>> = Object.freeze({
  'sale.action.sell_airtime': 'አየር ሰዓት ሽጥ',
  'sale.amount.select': 'መጠን ይምረጡ',
  'sale.confirm.action': 'ሽያጩን ያረጋግጡ',
  'status.processing': 'በሂደት ላይ',
  'status.pending': 'ግብይቱ በመጠባበቅ ላይ ነው',
  'status.pending.do_not_retry': 'እባክዎ ገና አይድገሙት',
  'status.successful': 'ግብይቱ ተሳክቷል',
  'status.failed': 'ግብይቱ አልተሳካም',
  'status.under_review': 'በምርመራ ላይ',
  'status.provider_unavailable': 'አቅራቢው ለጊዜው አገልግሎት አይሰጥም',
  'status.sales_unavailable': 'ሽያጭ ለጊዜው አይቻልም',
  'status.no_charge': 'ምንም ክፍያ አልተቀነሰም',
  'balance.available': 'ዝግጁ ቀሪ ሂሳብ',
  'balance.reserved': 'የተያዘ ቀሪ ሂሳብ',
  'balance.under_review': 'በምርመራ ላይ ያለ ቀሪ ሂሳብ',
  'commission.net': 'የተጣራ ኮሚሽን',
  'receipt.reprint': 'ደረሰኝ እንደገና ያትሙ',
  'transaction.id': 'የግብይት መለያ ቁጥር',
  'support.contact': 'ድጋፍ ያግኙ',
  'mode.training': 'የልምምድ ሁኔታ — እውነተኛ ዋጋ የለውም',
  'status.pending.message': 'ይህ ግብይት አሁንም እየተጣራ ነው። እባክዎ ገና አይድገሙት።',
  'status.under_review.message':
    'ይህ ግብይት በምርመራ ላይ ነው። ከአቅራቢው ጋር እያጣራን ስንቆይ ቀሪ ሂሳብዎ የተጠበቀ ነው።',
  'status.failed.message': 'ይህ ሽያጭ አልተፈጸመም። ምንም ክፍያ አልተቀነሰም።',
  'status.provider_unavailable.message':
    'ከዚህ አቅራቢ የአየር ሰዓት ለጊዜው አይገኝም። ምንም ክፍያ አልተቀነሰም። ሌሎች አገልግሎቶች እየሠሩ ናቸው።',
  'status.offline.message': 'ሽያጭ ለጊዜው አይቻልም። ታሪክ፣ ሪፖርቶችና ድጋፍ አሁንም ማየት ይችላሉ።',
  'receipt.reprint.notice': 'ይህ እንደገና የታተመ ደረሰኝ ነው። አዲስ ሽያጭ አይደለም።',
  'funding.simulated.notice': 'ይህ የሙከራ የገንዘብ ማስገቢያ ነው። እውነተኛ ገንዘብ አልተካተተም።',
  'error.validation.recipient': 'የስልክ ቁጥሩን አረጋግጠው እንደገና ይሞክሩ።',
  'error.balance.insufficient': 'ለዚህ ሽያጭ በቂ ዝግጁ ቀሪ ሂሳብ የለም።',
  'error.permission.denied': 'የእርስዎ ሚና ይህን ተግባር አይፈቅድም።',
  'error.session.expired': 'ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ። ምንም አልጠፋም።',
  'error.printer.failed': 'ደረሰኙ አልታተመም። ሽያጩ ተጠናቋል — እንደገና ማተም ይችላሉ።',
  'error.duplicate.blocked': 'ይህ ሽያጭ አስቀድሞ በሂደት ላይ ነው። እንደገና አይጀምሩት።',
});

export const TABLES: Readonly<Record<Locale, Readonly<Partial<Record<MessageKey, string>>>>> =
  Object.freeze({ en: EN, am: AM });
