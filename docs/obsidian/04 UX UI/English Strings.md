---
title: English Strings
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - localization
  - english
related:
  - "[[00 Home]]"
  - "[[Amharic Strings]]"
  - "[[Screen Inventory]]"
  - "[[Design System]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# English Strings

The English source of every merchant-facing string. **This is the authoritative wording** —
[[Amharic Strings]] translates from here, and no Amharic string may say more than its English
source claims.

Key format: `area.screen.element`.

## Merchant-critical terms

These twenty carry the most operational weight. A mistake here costs money or trust.

| Key | English |
|---|---|
| `sale.action.sell_airtime` | Sell airtime |
| `sale.amount.select` | Select amount |
| `sale.confirm.action` | Confirm sale |
| `status.processing` | Processing |
| `status.pending` | Transaction pending |
| `status.pending.do_not_retry` | Do not retry yet |
| `status.successful` | Transaction successful |
| `status.failed` | Transaction failed |
| `status.under_review` | Under review |
| `status.provider_unavailable` | Provider temporarily unavailable |
| `status.sales_unavailable` | Sales temporarily unavailable |
| `status.no_charge` | No charge was made |
| `balance.available` | Available balance |
| `balance.reserved` | Reserved balance |
| `balance.under_review` | Under review balance |
| `commission.net` | Net commission |
| `receipt.reprint` | Reprint receipt |
| `transaction.id` | Transaction ID |
| `support.contact` | Contact support |
| `mode.training` | Training mode — no real value |

## Full messages

| Key | English |
|---|---|
| `status.pending.message` | This transaction is still being checked. Do not retry yet. |
| `status.under_review.message` | This transaction is being reviewed. Your balance is protected while we check with the provider. |
| `status.failed.message` | This sale did not go through. No charge was made. |
| `status.provider_unavailable.message` | Airtime is temporarily unavailable from this provider. No charge was made. Other services are still working. |
| `status.offline.message` | Sales are temporarily unavailable. You can still view history, reports and support. |
| `receipt.reprint.notice` | This is a reprint. It is not a new sale. |
| `support.response.notice` | We will give you a first answer straight away and a final answer within 24 hours. |
| `funding.simulated.notice` | This is a simulated funding submission. No real money is involved. |

## Screen titles

| Key | English |
|---|---|
| `screen.login` | Sign in |
| `screen.home` | Home |
| `screen.provider_select` | Select network |
| `screen.amount_select` | Select amount |
| `screen.recipient` | Confirm number |
| `screen.confirm` | Confirm sale |
| `screen.balance` | Balance |
| `screen.search` | Find transaction |
| `screen.details` | Transaction details |
| `screen.reports` | Reports |
| `screen.funding` | Add funds |
| `screen.support` | Support |
| `screen.admin_queue` | Review queue |

## Errors

| Key | English |
|---|---|
| `error.validation.recipient` | Check the phone number and try again. |
| `error.balance.insufficient` | Not enough available balance for this sale. |
| `error.permission.denied` | Your role does not allow this action. |
| `error.session.expired` | Your session has ended. Sign in again. Nothing was lost. |
| `error.printer.failed` | The receipt did not print. The sale is complete — you can reprint it. |
| `error.duplicate.blocked` | This sale is already in progress. Do not start it again. |

## Wording rules

1. Never promise speed. No "instant", "immediately", or "right away" about a provider outcome.
2. Never call an unknown outcome a failure. `PENDING` is *"still being checked"*, never *"failed"*.
3. Always say when no charge was made. Merchants assume the worst in silence.
4. Never blame the merchant for a provider fault.
5. Short sentences. A busy shop owner reads four words, not a paragraph.

## Related

- [[Amharic Strings]]
- [[Screen Inventory]]
- [[Receipt Specification]]

---
Back to [[00 Home]]
