---
title: Domain Glossary
type: domain
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - domain
  - glossary
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Ledger Invariants]]"
  - "[[Balance Model]]"
  - "[[Architecture]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Domain Glossary

The twenty-seven minimum entities, with the meaning each one carries in Telga. These names are
used verbatim in code — `packages/domain` mirrors this table.

## Identity and access

| Entity | Meaning |
|---|---|
| `Company` | MuleSoo Digital Services. The legal entity operating Telga. |
| `TeamMember` | An internal MuleSoo person with a role from [[Founders and Roles]]. |
| `Merchant` | A shop. Owns a selling balance and a set of devices and users. |
| `MerchantUser` | A person operating on behalf of a merchant, with a PIN and a role. |
| `Device` | A registered Android phone or smart-POS unit, bound to one merchant. |

## Catalog

| Entity | Meaning |
|---|---|
| `Product` | A sellable item, e.g. an airtime denomination for a given network. |
| `Provider` | An authorized airtime provider, distributor, or integration partner. |
| `ProviderCapability` | What a provider can actually do: submit, status, reverse, health. |

## Transaction

| Entity | Meaning |
|---|---|
| `Transaction` | One logical sale. Survives retries. Never duplicated by an uncertain outcome. |
| `TransactionAttempt` | One submission to a provider within a transaction. A transaction may have several. |
| `IdempotencyRecord` | The key binding a merchant request to exactly one transaction. See [[Idempotency]]. |

## Money

| Entity | Meaning |
|---|---|
| `LedgerAccount` | A segregated account: merchant funds, Telga revenue, provider settlement, hardware deposits, refund reserves. |
| `LedgerEntry` | An append-only debit or credit. Never edited, never deleted. |
| `BalanceReservation` | Value held against a merchant's available balance while an outcome is unknown. |
| `CommissionRule` | Versioned rule producing gross commission. Rates NOT YET CONFIRMED. |
| `FeeRule` | Versioned rule producing the Telga fee. Rates NOT YET CONFIRMED. |

## Evidence

| Entity | Meaning |
|---|---|
| `Receipt` | The printable record of a transaction result. See [[Receipt Specification]]. |
| `ReprintEvent` | A record that a receipt was printed again. **Never a sale.** |
| `AuditEvent` | An append-only record of who did what, when, on which device. |

## Funding

| Entity | Meaning |
|---|---|
| `FundingSubmission` | A merchant's claim to have deposited funds. Simulated only. |
| `FundingVerification` | An operations decision on a submission, with verifier and approver. |

## Support

| Entity | Meaning |
|---|---|
| `SupportCase` | A merchant-raised issue, usually "paid but no airtime". |
| `Dispute` | An escalated case with a contested outcome and a responsible party. |
| `ProviderHealthEvent` | An observed provider degradation or outage. Internal only. |

## Platform

| Entity | Meaning |
|---|---|
| `Notification` | A message to a merchant or operator. |
| `FeatureFlag` | A capability switch. See [[Feature Flags]]. |
| `PilotMetric` | A measured value feeding the pilot measurement record (commercial material, kept outside this repository). |

## Transaction states

The twelve states a `Transaction` can occupy, as first-class vocabulary. Full transition rules in
[[Transaction State Machine]]; implemented in `packages/domain/src/states.ts`.

| State | One-line meaning | Value bucket |
|---|---|---|
| `CREATED` | The record and its `IdempotencyRecord` exist; nothing validated, nothing held | None |
| `VALIDATED` | Merchant, device, product, limits and capacity all pass; still nothing held | None |
| `RESERVED` | A `BalanceReservation` holds merchant value against this sale | Reserved |
| `SUBMITTED` | The provider request has been sent and acknowledged | Reserved |
| `PROCESSING` | Awaiting the provider outcome | Reserved |
| `PENDING` | The provider has not answered — **outcome unknown, not a failure** | Reserved |
| `UNDER_REVIEW` | Pending exceeded the provider maximum; escalated, funds protected | Under review |
| `REVERSAL_REQUIRED` | Value was taken and delivery did not happen; awaiting an adjustment entry | Under review |
| `SUCCESSFUL` | Delivery confirmed; debit finalized | Debited |
| `FAILED` | Failure confirmed; reservation released, no charge | Released |
| `REVERSED` | An authorized adjustment entry has been posted | Released |
| `REJECTED` | Refused before anything was held; no charge, no debit, no commission | Released |

The first four are named here explicitly because they carry meaning the later states depend on:
`CREATED` is where the idempotency key is bound, `VALIDATED` is the last point at which a sale can
be refused for free, `RESERVED` is where merchant value first stops being spendable, and
`REVERSAL_REQUIRED` is the only route to `REVERSED`.

## Ledger account types

Nine account types exist in the persisted ledger. The three merchant buckets are how the balance
views in [[Balance Model]] become postings rather than derived figures.

| Account type | Merchant-facing | Holds |
|---|---|---|
| `MERCHANT_AVAILABLE` | Yes | Value the merchant can sell against |
| `MERCHANT_RESERVED` | Yes | Value held against an in-flight sale |
| `MERCHANT_UNDER_REVIEW` | Yes | Value held pending determination |
| `MERCHANT_FUNDS` | Yes | Undivided merchant balance, used by the in-memory model |
| `PROVIDER_SETTLEMENT` | No | Owed to or from a provider |
| `TELGA_REVENUE` | No | Fees actually earned |
| `HARDWARE_DEPOSITS` | No | Refundable device deposits |
| `REFUND_RESERVES` | No | Held against expected reversals |
| `BANK_CLEARING` | **No** | Bookkeeping contra account. Holds no merchant value and appears in no merchant balance |

Two more words the persistence layer adds:

- **Posting** — a balanced set of ledger entries written as one unit. Identified by a `posting_id`.
- **Correlation id** — the thread tying a transaction's postings, reservation and audit events together across tables.

## Vocabulary rules

- **Pending** means *outcome unknown*, never *failed*. See [[Transaction State Machine]].
- **Available** never includes reserved or under-review value. See [[Balance Model]].
- **Reprint** is never a sale.
- **Money** is integer minor units of Ethiopian birr (santim). Never a floating-point number.
- **Correction** is an authorized adjustment entry, never an edit.

## Related

- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[Balance Model]]
- [[Idempotency]]

---
Back to [[00 Home]]
