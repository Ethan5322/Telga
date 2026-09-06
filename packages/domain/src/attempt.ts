/**
 * Provider attempts, and provider health over time.
 *
 * Two of the entities CLAUDE.md §12 names in the minimum domain model, and the
 * two this build had nowhere to put.
 *
 * ## Why an attempt is not a transaction
 *
 * §30 forbids retrying an uncertain outcome as a new transaction, and §14 has a
 * transaction that can be submitted, time out, become `PENDING`, be polled, and
 * only then resolve. So **one logical transaction legitimately produces several
 * provider round-trips**, and something has to hold them.
 *
 * Until now the only trace was a counter on the recovery claim. That answers
 * "how many times have we asked". It cannot answer the questions a dispute
 * turns on: when did we ask, what did the provider say each time, and which
 * attempt produced the reference the customer is holding. §17 gives a 24-hour
 * target for a final answer on "paid but no airtime"; these records are what
 * make that answerable from the data rather than from a rotated log.
 *
 * ## Why "no answer" is a value and not a gap
 *
 * `finishedAt` and `outcome` are both nullable, and a row with neither is the
 * most important row in the table: *we asked and never heard back*. §15 says a
 * timeout is not a failure, so the record must be able to say "unknown" as
 * plainly as it says "succeeded". Treating the absence as missing data — or
 * defaulting it to a failure — is the exact mistake §30 forbids.
 */

import type { AttemptId, ProviderId, Timestamp, TransactionId } from './ids';

/**
 * What a single provider round-trip ended as.
 *
 * `NOT_ANSWERED` is distinct from `TIMEOUT`: a timeout is a deadline this side
 * gave up on, and `NOT_ANSWERED` is a connection that produced nothing at all.
 * They are recorded apart because they point at different faults — one is a
 * slow provider, the other is a broken path to it — even though both mean the
 * same thing to the reservation, which is: hold it.
 */
export type AttemptOutcome = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'MALFORMED' | 'NOT_ANSWERED';

/** The outcomes that leave the result genuinely unknown. */
export const UNCERTAIN_ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = Object.freeze([
  'TIMEOUT',
  'MALFORMED',
  'NOT_ANSWERED',
]);

export const isUncertainAttempt = (outcome: AttemptOutcome | null): boolean =>
  outcome === null || UNCERTAIN_ATTEMPT_OUTCOMES.includes(outcome);

export interface TransactionAttempt {
  readonly id: AttemptId;
  readonly transactionId: TransactionId;
  /** 1 for the first submission. Unique within a transaction. */
  readonly attemptNo: number;
  readonly providerId: ProviderId;
  readonly startedAt: Timestamp;
  /** `null` while in flight — and forever, for one that never came back. */
  readonly finishedAt: Timestamp | null;
  /** `null` means no answer yet. See the note above: that is a state. */
  readonly outcome: AttemptOutcome | null;
  readonly providerReference: string | null;
  /** Ties this attempt to the worker's log lines. Carries no personal data. */
  readonly correlationId: string;
}

/**
 * Start an attempt.
 *
 * Written when the request goes out, not when it comes back. A row created only
 * on completion would be missing exactly the attempts worth investigating.
 */
export function startAttempt(input: {
  readonly id: AttemptId;
  readonly transactionId: TransactionId;
  readonly attemptNo: number;
  readonly providerId: ProviderId;
  readonly at: Timestamp;
  readonly correlationId: string;
}): TransactionAttempt {
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1) {
    throw new RangeError(`Attempt number must be a positive integer; received ${input.attemptNo}`);
  }
  return {
    id: input.id,
    transactionId: input.transactionId,
    attemptNo: input.attemptNo,
    providerId: input.providerId,
    startedAt: input.at,
    finishedAt: null,
    outcome: null,
    providerReference: null,
    correlationId: input.correlationId,
  };
}

/**
 * Close an attempt with what the provider said.
 *
 * Returns a new record rather than mutating: an attempt already finished cannot
 * be finished again, and saying so as a refusal is better than letting a late
 * duplicate response overwrite the first answer.
 */
export function finishAttempt(
  attempt: TransactionAttempt,
  result: {
    readonly outcome: AttemptOutcome;
    readonly at: Timestamp;
    readonly providerReference?: string;
  },
): TransactionAttempt {
  if (attempt.finishedAt !== null) {
    throw new Error(
      `Attempt ${attempt.id} already finished at ${attempt.finishedAt}; refusing to overwrite ` +
        `outcome ${String(attempt.outcome)} with ${result.outcome}.`,
    );
  }
  return {
    ...attempt,
    finishedAt: result.at,
    outcome: result.outcome,
    providerReference: result.providerReference ?? attempt.providerReference,
  };
}

// ---------------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------------

/**
 * Three states, not two.
 *
 * `DEGRADED` exists because §16 requires outage isolation to be proportionate:
 * a provider answering slowly is not a provider that is down, and collapsing
 * the two would either block sales that would have succeeded or keep selling
 * through an outage. Which of those is worse depends on the shop, so the
 * product needs to be able to tell them apart.
 */
export type ProviderHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';

/**
 * A provider changing state.
 *
 * Deliberately **not** keyed to a merchant. An outage is a platform fact, the
 * same for every shop, and attributing it per merchant would invite a
 * per-merchant override — which §16 forbids in as many words: *"No merchant
 * override."*
 */
export interface ProviderHealthEvent {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly at: Timestamp;
  readonly status: ProviderHealthStatus;
  /**
   * What it was immediately before. `null` for the first event ever recorded
   * for a provider.
   *
   * Stored rather than derived so that an outage's duration is answerable from
   * two adjacent rows — §26 asks for outage duration as a pilot metric, and a
   * metric that needs a window function over the whole table to compute is one
   * nobody computes.
   */
  readonly previousStatus: ProviderHealthStatus | null;
  /** Plain words for an operator. Never a provider error dump — this can reach a screen. */
  readonly detail: string | null;
  readonly correlationId: string | null;
}

/** Whether a state change is worth recording at all. */
export const isHealthChange = (
  previous: ProviderHealthStatus | null,
  next: ProviderHealthStatus,
): boolean => previous !== next;

/**
 * Record a health transition, or `undefined` when nothing changed.
 *
 * Returning `undefined` for an unchanged status is the point: a health check
 * that runs every thirty seconds would otherwise write a row every thirty
 * seconds, and a table of a hundred thousand "still healthy" rows is one
 * nobody can read an outage out of.
 */
export function recordHealthChange(input: {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly at: Timestamp;
  readonly status: ProviderHealthStatus;
  readonly previousStatus: ProviderHealthStatus | null;
  readonly detail?: string;
  readonly correlationId?: string;
}): ProviderHealthEvent | undefined {
  if (!isHealthChange(input.previousStatus, input.status)) return undefined;
  return {
    id: input.id,
    providerId: input.providerId,
    at: input.at,
    status: input.status,
    previousStatus: input.previousStatus,
    detail: input.detail ?? null,
    correlationId: input.correlationId ?? null,
  };
}

/** Whether this provider's products may be sold right now. */
export const sellableUnder = (status: ProviderHealthStatus): boolean => status !== 'UNAVAILABLE';

/**
 * How long a provider spent not fully healthy, in milliseconds.
 *
 * Takes the events in the order they happened and the moment "now", because an
 * outage that has not ended yet still has a duration — and that is the one a
 * shop is asking about while it is happening.
 */
export function unhealthyMillis(
  events: readonly ProviderHealthEvent[],
  now: Timestamp,
): number {
  let total = 0;
  let openedAt: number | undefined;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    if (event.status === 'HEALTHY') {
      if (openedAt !== undefined) {
        total += at - openedAt;
        openedAt = undefined;
      }
    } else if (openedAt === undefined) {
      openedAt = at;
    }
  }
  if (openedAt !== undefined) {
    const end = Date.parse(now);
    if (!Number.isNaN(end)) total += end - openedAt;
  }
  return total;
}
