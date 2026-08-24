---
title: Mock Provider Behavior
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - provider
  - testing
related:
  - "[[00 Home]]"
  - "[[API Contracts]]"
  - "[[Transaction Orchestration]]"
  - "[[Provider Health]]"
  - "[[Testing Strategy]]"
depends_on:
  - "[[API Contracts]]"
implements: []
validates:
  - "[[Transaction State Machine]]"
decision_status: confirmed
---

# Mock Provider Behavior

`services/provider-adapters/mock-airtime` — the **only** `AirtimeProvider` implementation in this
repository.

> [!important] Live integration is absent, not disabled
> There is no HTTP client, no fetch, no socket and no credential in this package. A feature flag
> can be flipped by mistake; missing code cannot.

## Determinism

No `Math.random`. No `Date.now`. No `setTimeout`.

- Time advances only when a caller invokes `advance(ticks)`.
- Seeded behaviour selection is a pure function of the idempotency key and the seed.
- The provider reference is a pure function of the idempotency key.

The same scenario therefore replays exactly, which is what makes a failure reproducible rather than
occasional.

## The eight behaviours

| Behaviour | `submit` returns | `getStatus` returns | Transaction lands in |
|---|---|---|---|
| `SUCCESS` | `CONFIRMED_SUCCESS` | `SUCCESS` | `SUCCESSFUL` |
| `FAILURE` | `CONFIRMED_FAILURE` | `FAILURE` | `FAILED` |
| `TIMEOUT` | `INDETERMINATE` | `STILL_PENDING` forever | `PENDING` → `UNDER_REVIEW` |
| `DELAYED_SUCCESS` | `INDETERMINATE` | `STILL_PENDING`, then `SUCCESS` after `delayTicks` | `PENDING` → `SUCCESSFUL` |
| `DELAYED_FAILURE` | `INDETERMINATE` | `STILL_PENDING`, then `FAILURE` after `delayTicks` | `PENDING` → `FAILED` |
| `MALFORMED_RESPONSE` | `INDETERMINATE` | `STILL_PENDING` forever | `PENDING` |
| `DUPLICATE_CALLBACK` | `INDETERMINATE`, queues the same callback twice | `SUCCESS` | `PENDING` → `SUCCESSFUL`, applied once |
| `OUTAGE` | `REJECTED`, nothing attempted | `UNKNOWN_REFERENCE` | Blocked before any transaction exists |

## The two that matter most

**`MALFORMED_RESPONSE`** must never be read as a success. A body we cannot parse tells us nothing,
so it is `INDETERMINATE` — the same as a timeout. Tested explicitly:
`a malformed provider response is pending, never a false success`.

**`DUPLICATE_CALLBACK`** delivers the same logical callback twice with the same `deliveryOf`. A
handler that de-duplicates on `deliveryOf` applies it once. In the orchestration, the reservation
guard and the pending-job guard make a repeat harmless even if the handler forgot.

## Re-submission

Submitting the same idempotency key twice returns `DUPLICATE` with the original provider
reference — **never a second vend**. `DUPLICATE` maps to `PENDING`, not to success: the caller must
resolve it through `getStatus`, because a duplicate acknowledgement is not a delivery confirmation.

## Safety

Every result carries `simulated: true`. `submit` calls `assertSimulated(context.mode)` and throws
`LiveMoneyDisabledError` on anything but `TRAINING`, so a live context fails at the adapter edge
even if it somehow passed the orchestration guard.

## What this mock cannot tell us

Recorded honestly:

| Unknown | Why it matters |
|---|---|
| Real provider latency | The internal targets in [[Observability]] are untested against a real network |
| Real timeout semantics | The 5-minute pending maximum is an assumed default (A7) |
| Real idempotency support | Whether the first provider honours a client reference is NOT YET CONFIRMED (A12) |
| Real status-lookup availability | The hard gate in the provider integration requirements (commercial material, kept outside this repository), still unverified (A11) |
| Real reversal capability | `reverse()` is optional in the contract for exactly this reason |

## Related

- [[API Contracts]]
- [[Transaction Orchestration]]
- [[Provider Health]]
- [[Testing Strategy]]

---
Back to [[00 Home]]
