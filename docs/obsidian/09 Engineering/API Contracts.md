---
title: API Contracts
type: engineering
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - engineering
  - api
  - provider
related:
  - "[[00 Home]]"
  - "[[Architecture]]"
  - "[[Idempotency]]"
depends_on:
  - "[[Architecture]]"
implements: []
validates: []
decision_status: confirmed
---

# API Contracts

## Provider adapter

The one interface every provider implementation satisfies. Taken verbatim from the specification.

```ts
interface AirtimeProvider {
  submit(request: AirtimeRequest, context: ProviderContext): Promise<ProviderSubmissionResult>;
  getStatus(query: ProviderStatusQuery): Promise<ProviderStatus>;
  reverse?(request: ProviderReversalRequest): Promise<ProviderReversalResult>;
  healthCheck(): Promise<ProviderHealth>;
}
```

| Method | Required? | Notes |
|---|---|---|
| `submit` | Yes | Carries the idempotency key; may return an indeterminate result |
| `getStatus` | **Yes** | Hard gate. Without it a pending transaction can never resolve — the provider integration requirements (commercial material, kept outside this repository) |
| `reverse` | Optional | Optional in the interface because provider capability is NOT YET CONFIRMED |
| `healthCheck` | Yes | Drives outage isolation — [[Provider Health]] |

### Submission results

`submit` must be able to express **"I do not know"**. A boolean success flag would be a defect.

| Result | Meaning | Transaction goes to |
|---|---|---|
| `CONFIRMED_SUCCESS` | Delivered | `SUCCESSFUL` |
| `CONFIRMED_FAILURE` | Definitely not delivered | `FAILED` |
| `INDETERMINATE` | Timeout, malformed, or unreachable | `PENDING` |
| `DUPLICATE` | Provider already has this reference | Resolve via `getStatus` |
| `REJECTED` | Provider refused before attempting | `FAILED`, no charge |

### Mock provider behaviours

The only implementation that exists. Deterministic and seeded, so a scenario replays exactly.

`SUCCESS` · `FAILURE` · `TIMEOUT` · `DELAYED_SUCCESS` · `DELAYED_FAILURE` · `MALFORMED_RESPONSE` ·
`DUPLICATE_CALLBACK` · `OUTAGE`

> [!important] No live provider client exists
> There is no HTTP client in `services/provider-adapters`. Live integration is **absent**, not
> disabled — a flag can be flipped by mistake; missing code cannot.

## Persistence contract

`LedgerDriver` (`packages/persistence/src/driver/types.ts`) is the second contract in the system.
Implemented once, by SQLite; a Postgres implementation at Phase 3 changes no caller.

| Group | Operations |
|---|---|
| Lifecycle | `migrate` · `appliedMigrations` · `health` · `pragmas` · `close` · `isOpen` |
| Unit of work | `transaction<T>(work)` |
| Ledger | `appendEntries` · `readEntries` · `readEntriesByMerchant` · `readEntriesByAccount` · `readEntriesByTransaction` |
| Accounts | `ensureAccount` · `findAccount` |
| Balances | `balanceFor` · `ledgerResidualMinor` |
| Merchants and devices | `saveMerchant` · `findMerchant` · `saveDevice` · `findDevice` |
| Transactions | `saveTransaction` · `findTransaction` · `findTransactionsByMerchant` |
| Idempotency | `saveIdempotencyRecord` · `findIdempotencyRecord` |
| Reservations | `saveReservation` · `findReservation` · `findReservationsByMerchant` |
| Audit | `saveAuditEvent` · `readAuditEvents` |

> [!important] What the contract deliberately omits
> There is **no** `updateLedgerEntry` and **no** `deleteLedgerEntry`. The interface offers no way
> to mutate ledger history, and the database refuses it independently — see
> [[SQLite Persistence Layer]].

Every scoped read takes a `MerchantId` and filters **in SQL**. A foreign row is not returned and
then filtered by the caller; it is never fetched.

## Application services

| Service | Input | Output |
|---|---|---|
| `createSale` | `SaleRequest` | `SaleResult` |
| `resolvePending` | transaction id + merchant id | `SaleResult` |
| `requireReversal` | transaction id + merchant id + reason | `SaleResult` |
| `completeReversal` | transaction id + merchant id | `SaleResult` |

`SaleResult` is a discriminated union: six outcome kinds and nine rejection kinds, each carrying a
`nextAction` the POS switches on and a `messageKey` resolved against the bilingual string files.
Rejections carry a stable `reasonCode` for logs. **No raw error text ever crosses this boundary.**
See [[Create Sale Service]].

## Internal API principles

| Principle | Detail |
|---|---|
| Idempotency key required | On every state-changing merchant operation — [[Idempotency]] |
| Server-authoritative money | The client never sends a balance or a computed price |
| Explicit states | Responses carry the transaction state, never a bare success boolean |
| Feature-flag enforcement | A disabled capability returns `FEATURE_DISABLED`, never a partial execution |
| Audit on every mutation | Actor, device, merchant, timestamp |

## Core endpoints

| Endpoint | Purpose | Idempotent |
|---|---|---|
| `POST /sales` | Create an airtime sale | **Yes** — key required |
| `GET /sales/{id}` | Current state and history | Read |
| `GET /sales` | Search by ID, receipt, time, amount, reference | Read |
| `POST /sales/{id}/receipt/reprint` | Emit a `ReprintEvent` | Yes — **never a sale** |
| `GET /balance` | The four derived views | Read |
| `POST /funding` | Simulated funding submission | Yes |
| `POST /support/cases` | Raise a case | Yes |
| `POST /webhooks/provider/{provider}` | Provider callback | **Yes** — signed, replay-protected |

## Callback contract

1. Verify signature. Reject unsigned or badly signed.
2. Reject replays outside the accepted window.
3. Look up the transaction by provider reference.
4. If already terminal — acknowledge and **discard**.
5. Otherwise apply the transition through the state machine, never by direct write.

## Error shape

Errors name the state and what the merchant should do, because the string reaches a person at a
counter: `FEATURE_DISABLED` · `INSUFFICIENT_AVAILABLE_BALANCE` · `IDEMPOTENCY_PAYLOAD_MISMATCH` ·
`PROVIDER_UNAVAILABLE` · `PERMISSION_DENIED` · `SESSION_EXPIRED` · `DUPLICATE_IN_PROGRESS`.

## Related

- [[Architecture]]
- [[Idempotency]]
- [[Security Model]]

---
Back to [[00 Home]]
