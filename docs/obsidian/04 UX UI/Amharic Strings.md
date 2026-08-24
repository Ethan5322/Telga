---
title: Amharic Strings
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - localization
  - amharic
  - needs-review
related:
  - "[[00 Home]]"
  - "[[Merchant POS Screens]]"
  - "[[English Strings]]"
  - "[[Screen Inventory]]"
  - "[[Decision Log]]"
depends_on:
  - "[[English Strings]]"
implements: []
validates: []
decision_status: pending
---

# Amharic Strings

> [!danger] REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION
> Every Amharic string on this page is a **draft produced by Claude, not a finished translation**.
> None of it has been reviewed by a native Amharic speaker. It must not reach a merchant, a
> receipt, a printed material, or a production build until a named reviewer has signed it off in
> [[Decision Log]].
>
> The highest-risk string on this page is `status.pending.do_not_retry`. If a merchant
> misreads it, they retry, and a retry on a misunderstood pending state is how duplicate sales and
> lost money happen. Review that line first.

**Reviewer:** NOT YET ASSIGNED
**Review status:** NOT REVIEWED
**Target register:** simple professional Amharic suitable for shop owners — not academic, not
literal-from-English.

## Merchant-critical terms

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `sale.action.sell_airtime` | Sell airtime | አየር ሰዓት ሽጥ | ☐ |
| `sale.amount.select` | Select amount | መጠን ይምረጡ | ☐ |
| `sale.confirm.action` | Confirm sale | ሽያጩን ያረጋግጡ | ☐ |
| `status.processing` | Processing | በሂደት ላይ | ☐ |
| `status.pending` | Transaction pending | ግብይቱ በመጠባበቅ ላይ ነው | ☐ |
| `status.pending.do_not_retry` | Do not retry yet | እባክዎ ገና አይድገሙት | ☐ **priority** |
| `status.successful` | Transaction successful | ግብይቱ ተሳክቷል | ☐ |
| `status.failed` | Transaction failed | ግብይቱ አልተሳካም | ☐ |
| `status.under_review` | Under review | በምርመራ ላይ | ☐ |
| `status.provider_unavailable` | Provider temporarily unavailable | አቅራቢው ለጊዜው አገልግሎት አይሰጥም | ☐ |
| `status.sales_unavailable` | Sales temporarily unavailable | ሽያጭ ለጊዜው አይቻልም | ☐ |
| `status.no_charge` | No charge was made | ምንም ክፍያ አልተቀነሰም | ☐ |
| `balance.available` | Available balance | ዝግጁ ቀሪ ሂሳብ | ☐ |
| `balance.reserved` | Reserved balance | የተያዘ ቀሪ ሂሳብ | ☐ |
| `balance.under_review` | Under review balance | በምርመራ ላይ ያለ ቀሪ ሂሳብ | ☐ |
| `commission.net` | Net commission | የተጣራ ኮሚሽን | ☐ |
| `receipt.reprint` | Reprint receipt | ደረሰኝ እንደገና ያትሙ | ☐ |
| `transaction.id` | Transaction ID | የግብይት መለያ ቁጥር | ☐ |
| `support.contact` | Contact support | ድጋፍ ያግኙ | ☐ |
| `mode.training` | Training mode — no real value | የልምምድ ሁኔታ — እውነተኛ ዋጋ የለውም | ☐ |

## Full messages

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `status.pending.message` | This transaction is still being checked. Do not retry yet. | ይህ ግብይት አሁንም እየተጣራ ነው። እባክዎ ገና አይድገሙት። | ☐ **priority** |
| `status.under_review.message` | This transaction is being reviewed. Your balance is protected while we check with the provider. | ይህ ግብይት በምርመራ ላይ ነው። ከአቅራቢው ጋር እያጣራን ስንቆይ ቀሪ ሂሳብዎ የተጠበቀ ነው። | ☐ |
| `status.failed.message` | This sale did not go through. No charge was made. | ይህ ሽያጭ አልተፈጸመም። ምንም ክፍያ አልተቀነሰም። | ☐ |
| `status.provider_unavailable.message` | Airtime is temporarily unavailable from this provider. No charge was made. Other services are still working. | ከዚህ አቅራቢ የአየር ሰዓት ለጊዜው አይገኝም። ምንም ክፍያ አልተቀነሰም። ሌሎች አገልግሎቶች እየሠሩ ናቸው። | ☐ |
| `status.offline.message` | Sales are temporarily unavailable. You can still view history, reports and support. | ሽያጭ ለጊዜው አይቻልም። ታሪክ፣ ሪፖርቶችና ድጋፍ አሁንም ማየት ይችላሉ። | ☐ |
| `receipt.reprint.notice` | This is a reprint. It is not a new sale. | ይህ እንደገና የታተመ ደረሰኝ ነው። አዲስ ሽያጭ አይደለም። | ☐ |
| `funding.simulated.notice` | This is a simulated funding submission. No real money is involved. | ይህ የሙከራ የገንዘብ ማስገቢያ ነው። እውነተኛ ገንዘብ አልተካተተም። | ☐ |

## Errors

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `error.validation.recipient` | Check the phone number and try again. | የስልክ ቁጥሩን አረጋግጠው እንደገና ይሞክሩ። | ☐ |
| `error.balance.insufficient` | Not enough available balance for this sale. | ለዚህ ሽያጭ በቂ ዝግጁ ቀሪ ሂሳብ የለም። | ☐ |
| `error.permission.denied` | Your role does not allow this action. | የእርስዎ ሚና ይህን ተግባር አይፈቅድም። | ☐ |
| `error.session.expired` | Your session has ended. Sign in again. Nothing was lost. | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ። ምንም አልጠፋም። | ☐ |
| `error.printer.failed` | The receipt did not print. The sale is complete — you can reprint it. | ደረሰኙ አልታተመም። ሽያጩ ተጠናቋል — እንደገና ማተም ይችላሉ። | ☐ |
| `error.duplicate.blocked` | This sale is already in progress. Do not start it again. | ይህ ሽያጭ አስቀድሞ በሂደት ላይ ነው። እንደገና አይጀምሩት። | ☐ |

## The gap the POS renders around

Fourteen keys have **no Amharic at all**: the thirteen `screen.*` titles and
`support.response.notice`. They are absent rather than machine-translated, because an unreviewed
guess that looks finished is worse than a visible gap.

`translate()` in `@telga/localization` falls back to English **and reports that it did**, so a
screen marks the text as untranslated rather than pretending. `tests/ui/localization.test.ts`
pins the exact missing set and the coverage count, so adding or removing a translation is a
deliberate change rather than a silent one — and it fails if the tables here and in
[[English Strings]] drift from the code.

An Amharic screen also renders `REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION` on the page,
not only in this note. See [[Merchant POS Screens]].

## Review procedure

1. A named native Amharic speaker reviews every row and ticks its box.
2. Priority order: pending and do-not-retry strings, then no-charge strings, then balances, then the rest.
3. The reviewer checks **register** (professional but plain, as a shop owner speaks), **terminology consistency** (the same Amharic word for "balance" everywhere), and **truthfulness** (no Amharic string claiming more certainty than its English source).
4. Sign-off is recorded in [[Decision Log]] with the reviewer's name and date.
5. Until then, `decision_status` on this note stays `pending` and the strings stay out of any production build.

## Known open questions for the reviewer

- **"Airtime"** — is አየር ሰዓት the term shop owners actually use at the counter, or is a borrowed term more natural in practice?
- **"Under review"** — በምርመራ ላይ may read as an *investigation of the merchant*. A phrasing that clearly means *we are checking with the provider* would be safer.
- **Formality** — drafts use the polite form (ይምረጡ, ያረጋግጡ). Confirm this suits merchant-facing POS copy.
- **Numerals** — amounts and IDs stay in Latin digits per [[Design System]]. Confirm this matches merchant expectation.

## Related

- [[English Strings]]
- [[Design System]]
- [[Screen Inventory]]
- [[Decision Log]]

---
Back to [[00 Home]]
