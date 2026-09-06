/**
 * Provider attempts and provider health.
 *
 * Two of the entities CLAUDE.md §12 names and this build had nowhere to put.
 *
 * The assertions worth reading are the ones about **not knowing**. §15 says a
 * timeout is not a failure and §30 forbids retrying an uncertain outcome as a
 * new transaction — so an attempt record has to be able to say "we asked and
 * never heard back" as plainly as it says "succeeded". A model that collapses
 * that into a failure is the bug these tests exist to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
  UNCERTAIN_ATTEMPT_OUTCOMES,
  attemptId,
  finishAttempt,
  isHealthChange,
  isUncertainAttempt,
  providerId as toProviderId,
  recordHealthChange,
  sellableUnder,
  startAttempt,
  transactionId as toTransactionId,
  unhealthyMillis,
} from '@telga/domain';
import type { AttemptOutcome, ProviderHealthEvent, Timestamp } from '@telga/domain';

const at = (iso: string): Timestamp => iso as Timestamp;
const PROVIDER = toProviderId('provider_mock');
const TXN = toTransactionId('txn_0001');

const begin = (n = 1) =>
  startAttempt({
    id: attemptId(`att_000${n}`),
    transactionId: TXN,
    attemptNo: n,
    providerId: PROVIDER,
    at: at('2026-08-29T10:00:00.000Z'),
    correlationId: 'corr_1',
  });

describe('starting an attempt', () => {
  it('records it as in flight, with no outcome', () => {
    // Written when the request goes out. A row created only on completion
    // would be missing exactly the attempts worth investigating.
    const attempt = begin();
    expect(attempt.finishedAt).toBeNull();
    expect(attempt.outcome).toBeNull();
    expect(attempt.providerReference).toBeNull();
    expect(attempt.attemptNo).toBe(1);
  });

  it('refuses an attempt number that is not a positive integer', () => {
    // The number is a sequence within one transaction. A zero, a negative or a
    // fraction would make "which try was this" unanswerable.
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() =>
        startAttempt({
          id: attemptId('att_bad'),
          transactionId: TXN,
          attemptNo: bad,
          providerId: PROVIDER,
          at: at('2026-08-29T10:00:00.000Z'),
          correlationId: 'corr_1',
        }),
      ).toThrow(RangeError);
    }
  });
});

describe('finishing an attempt', () => {
  it('records what the provider said', () => {
    const done = finishAttempt(begin(), {
      outcome: 'SUCCESS',
      at: at('2026-08-29T10:00:03.000Z'),
      providerReference: 'PRV-991',
    });
    expect(done.outcome).toBe('SUCCESS');
    expect(done.finishedAt).toBe('2026-08-29T10:00:03.000Z');
    expect(done.providerReference).toBe('PRV-991');
  });

  it('refuses to overwrite an answer that already arrived', () => {
    // A late duplicate response must not rewrite the first one. CLAUDE.md §25
    // lists duplicate callbacks as a contract case, and this is the record-level
    // half of that refusal.
    const done = finishAttempt(begin(), { outcome: 'SUCCESS', at: at('2026-08-29T10:00:03.000Z') });
    expect(() =>
      finishAttempt(done, { outcome: 'FAILURE', at: at('2026-08-29T10:00:09.000Z') }),
    ).toThrow(/already finished/);
  });

  it('leaves the original record untouched', () => {
    // Returning a new record rather than mutating is what makes the refusal
    // above possible at all.
    const started = begin();
    finishAttempt(started, { outcome: 'FAILURE', at: at('2026-08-29T10:00:05.000Z') });
    expect(started.outcome).toBeNull();
    expect(started.finishedAt).toBeNull();
  });
});

describe('what counts as not knowing', () => {
  it('treats an unfinished attempt as uncertain', () => {
    // The most important row in the table: asked, never heard back.
    expect(isUncertainAttempt(null)).toBe(true);
  });

  it('treats timeout, malformed and no-answer as uncertain', () => {
    for (const outcome of UNCERTAIN_ATTEMPT_OUTCOMES) {
      expect(isUncertainAttempt(outcome), outcome).toBe(true);
    }
  });

  it('never treats a timeout as a failure', () => {
    // CLAUDE.md §30, stated directly. A timeout that reads as a confirmed
    // failure releases a reservation for a sale that may have been delivered.
    expect(UNCERTAIN_ATTEMPT_OUTCOMES).toContain('TIMEOUT');
    expect(UNCERTAIN_ATTEMPT_OUTCOMES).not.toContain('FAILURE');
    expect(isUncertainAttempt('FAILURE')).toBe(false);
  });

  it('treats only confirmed answers as certain', () => {
    const certain: AttemptOutcome[] = ['SUCCESS', 'FAILURE'];
    for (const outcome of certain) {
      expect(isUncertainAttempt(outcome), outcome).toBe(false);
    }
  });
});

describe('provider health', () => {
  it('records a change and nothing else', () => {
    // A health check every thirty seconds would otherwise write a row every
    // thirty seconds, and a table of "still healthy" is one nobody can read an
    // outage out of.
    const change = recordHealthChange({
      id: 'phe_1',
      providerId: PROVIDER,
      at: at('2026-08-29T10:00:00.000Z'),
      status: 'UNAVAILABLE',
      previousStatus: 'HEALTHY',
    });
    expect(change?.status).toBe('UNAVAILABLE');
    expect(change?.previousStatus).toBe('HEALTHY');

    const unchanged = recordHealthChange({
      id: 'phe_2',
      providerId: PROVIDER,
      at: at('2026-08-29T10:00:30.000Z'),
      status: 'HEALTHY',
      previousStatus: 'HEALTHY',
    });
    expect(unchanged).toBeUndefined();
  });

  it('treats the first ever observation as a change', () => {
    expect(isHealthChange(null, 'HEALTHY')).toBe(true);
  });

  it('distinguishes degraded from unavailable', () => {
    // §16 requires proportionate isolation: a slow provider is not a down one.
    // Collapsing the two either blocks sales that would have succeeded or keeps
    // selling through an outage.
    expect(sellableUnder('HEALTHY')).toBe(true);
    expect(sellableUnder('DEGRADED')).toBe(true);
    expect(sellableUnder('UNAVAILABLE')).toBe(false);
  });
});

describe('how long a provider was down', () => {
  const event = (
    iso: string,
    status: ProviderHealthEvent['status'],
    previous: ProviderHealthEvent['previousStatus'],
  ): ProviderHealthEvent => ({
    id: `phe_${iso}`,
    providerId: PROVIDER,
    at: at(iso),
    status,
    previousStatus: previous,
    detail: null,
    correlationId: null,
  });

  it('measures a closed outage between the two events that bound it', () => {
    // §26 asks for outage duration as a pilot metric.
    const ms = unhealthyMillis(
      [
        event('2026-08-29T10:00:00.000Z', 'UNAVAILABLE', 'HEALTHY'),
        event('2026-08-29T10:05:00.000Z', 'HEALTHY', 'UNAVAILABLE'),
      ],
      at('2026-08-29T11:00:00.000Z'),
    );
    expect(ms).toBe(5 * 60 * 1000);
  });

  it('counts an outage that has not ended yet, up to now', () => {
    // The duration a shop is asking about while it is happening.
    const ms = unhealthyMillis(
      [event('2026-08-29T10:00:00.000Z', 'UNAVAILABLE', 'HEALTHY')],
      at('2026-08-29T10:02:30.000Z'),
    );
    expect(ms).toBe(150_000);
  });

  it('counts degraded time as not fully healthy', () => {
    const ms = unhealthyMillis(
      [
        event('2026-08-29T10:00:00.000Z', 'DEGRADED', 'HEALTHY'),
        event('2026-08-29T10:01:00.000Z', 'HEALTHY', 'DEGRADED'),
      ],
      at('2026-08-29T11:00:00.000Z'),
    );
    expect(ms).toBe(60_000);
  });

  it('does not double-count a slide from degraded into unavailable', () => {
    // One continuous period of not-healthy, not two.
    const ms = unhealthyMillis(
      [
        event('2026-08-29T10:00:00.000Z', 'DEGRADED', 'HEALTHY'),
        event('2026-08-29T10:01:00.000Z', 'UNAVAILABLE', 'DEGRADED'),
        event('2026-08-29T10:03:00.000Z', 'HEALTHY', 'UNAVAILABLE'),
      ],
      at('2026-08-29T11:00:00.000Z'),
    );
    expect(ms).toBe(3 * 60 * 1000);
  });

  it('is zero for a provider that was never anything but healthy', () => {
    expect(unhealthyMillis([], at('2026-08-29T11:00:00.000Z'))).toBe(0);
    expect(
      unhealthyMillis(
        [event('2026-08-29T10:00:00.000Z', 'HEALTHY', null)],
        at('2026-08-29T11:00:00.000Z'),
      ),
    ).toBe(0);
  });
});
