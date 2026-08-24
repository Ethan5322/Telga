/**
 * Deterministic mock airtime provider.
 *
 * The only `AirtimeProvider` implementation in this repository. There is no
 * HTTP client, no fetch, no socket and no credential anywhere in this package —
 * live provider integration is *absent*, not disabled. A feature flag can be
 * flipped by mistake; missing code cannot.
 *
 * Determinism is total: no `Math.random`, no `Date.now`, no `setTimeout`. Time
 * advances only when a test calls `advance()`, and seeded behaviour selection
 * is a pure function of the idempotency key. The same scenario replays exactly.
 *
 * Every result carries `simulated: true`.
 */

import type {
  AirtimeProvider,
  AirtimeRequest,
  ProviderContext,
  ProviderHealth,
  ProviderId,
  ProviderReversalRequest,
  ProviderReversalResult,
  ProviderStatus,
  ProviderStatusQuery,
  ProviderSubmissionResult,
} from '@telga/domain';
import { assertSimulated } from '@telga/domain';

/** The eight behaviours required by `09 Engineering/Testing Strategy.md`. */
export const MOCK_BEHAVIOURS = [
  'SUCCESS',
  'FAILURE',
  'TIMEOUT',
  'DELAYED_SUCCESS',
  'DELAYED_FAILURE',
  'MALFORMED_RESPONSE',
  'DUPLICATE_CALLBACK',
  'OUTAGE',
] as const;

export type MockBehaviour = (typeof MOCK_BEHAVIOURS)[number];

export interface MockProviderOptions {
  readonly providerId: ProviderId;
  /** Fixed behaviour for every request, unless `seeded` is set. */
  readonly behaviour?: MockBehaviour;
  /**
   * When set, the behaviour is chosen deterministically from the idempotency
   * key and this seed. The same key and seed always select the same behaviour.
   */
  readonly seed?: number;
  /** Ticks before a delayed outcome resolves. */
  readonly delayTicks?: number;
  /** Per-recipient overrides, for scripting a mixed scenario. */
  readonly overrides?: Readonly<Record<string, MockBehaviour>>;
  /**
   * Force every status lookup to a fixed outcome, regardless of whether this
   * instance has seen the submission.
   *
   * A mock exists to be scripted, and this is what makes a *separate process*
   * testable: a recovery worker in a fresh process has no memory of the
   * original submission, so without this every lookup would be
   * `UNKNOWN_REFERENCE` and only the indeterminate path could ever be reached.
   */
  readonly statusOverride?: ProviderStatus['outcome'];
}

/** A callback the provider would deliver to the Telga webhook endpoint. */
export interface MockCallback {
  readonly idempotencyKey: string;
  readonly providerReference: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly simulated: true;
  /** Increments per delivery; a duplicate callback carries the same `deliveryOf`. */
  readonly deliveryId: string;
  readonly deliveryOf: string;
}

interface SubmissionRecord {
  readonly idempotencyKey: string;
  readonly providerReference: string;
  readonly behaviour: MockBehaviour;
  readonly submittedAtTick: number;
  seen: number;
}

/** FNV-1a — same helper the domain uses, kept local so this package stays standalone. */
function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

export class MockAirtimeProvider implements AirtimeProvider {
  private readonly options: MockProviderOptions;
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly pendingCallbacks: MockCallback[] = [];
  private tick = 0;
  /** Set by `useBehaviour`. Wins over `options.behaviour`, loses to a per-recipient override. */
  private scripted: MockBehaviour | undefined;

  constructor(options: MockProviderOptions) {
    this.options = options;
  }

  /**
   * Re-script the behaviour for subsequent submissions.
   *
   * A training POS lets an operator practise a specific outcome — a timeout, an
   * outage, a confirmed failure — and choosing it has to happen between sales
   * rather than at construction. Submissions already recorded keep their own
   * behaviour, so a status lookup for an earlier transaction still answers
   * consistently; only requests that have not been submitted yet are affected.
   */
  useBehaviour(behaviour: MockBehaviour): void {
    this.scripted = behaviour;
  }

  /** Advance the virtual clock. Nothing in this package resolves without it. */
  advance(ticks = 1): void {
    this.tick += ticks;
  }

  get now(): number {
    return this.tick;
  }

  /** Which behaviour applies to a request. Pure: same inputs, same answer. */
  behaviourFor(idempotencyKey: string, recipient?: string): MockBehaviour {
    const override = recipient === undefined ? undefined : this.options.overrides?.[recipient];
    if (override) return override;
    if (this.scripted) return this.scripted;
    if (this.options.behaviour) return this.options.behaviour;
    const seed = this.options.seed ?? 0;
    const index = hash(`${idempotencyKey}:${String(seed)}`) % MOCK_BEHAVIOURS.length;
    return MOCK_BEHAVIOURS[index] as MockBehaviour;
  }

  private reference(idempotencyKey: string): string {
    return `MOCKREF-${hash(idempotencyKey).toString(16).toUpperCase().padStart(8, '0')}`;
  }

  async submit(
    request: AirtimeRequest,
    context: ProviderContext,
  ): Promise<ProviderSubmissionResult> {
    // Refuse anything that is not simulated, even here at the edge.
    assertSimulated(context.mode);

    const behaviour = this.behaviourFor(request.idempotencyKey, request.recipient);
    const providerReference = this.reference(request.idempotencyKey);

    const existing = this.submissions.get(request.idempotencyKey);
    if (existing) {
      // The provider already has this reference. Never assume an outcome —
      // the caller must resolve it through getStatus().
      existing.seen += 1;
      return {
        outcome: 'DUPLICATE',
        providerReference: existing.providerReference,
        message: 'Reference already submitted; resolve via status lookup',
        simulated: true,
      };
    }

    if (behaviour === 'OUTAGE') {
      // Nothing is attempted, so nothing may be charged.
      return {
        outcome: 'REJECTED',
        message: 'Provider unavailable; request was not attempted',
        simulated: true,
      };
    }

    this.submissions.set(request.idempotencyKey, {
      idempotencyKey: request.idempotencyKey,
      providerReference,
      behaviour,
      submittedAtTick: this.tick,
      seen: 1,
    });

    switch (behaviour) {
      case 'SUCCESS':
        this.queueCallback(request.idempotencyKey, providerReference, 'SUCCESS', 1);
        return { outcome: 'CONFIRMED_SUCCESS', providerReference, simulated: true };

      case 'FAILURE':
        this.queueCallback(request.idempotencyKey, providerReference, 'FAILURE', 1);
        return { outcome: 'CONFIRMED_FAILURE', providerReference, simulated: true };

      case 'MALFORMED_RESPONSE':
        // A malformed body tells us nothing. It must not crash and must never
        // be read as a success.
        return {
          outcome: 'INDETERMINATE',
          providerReference,
          message: 'Malformed provider response',
          simulated: true,
        };

      case 'DUPLICATE_CALLBACK':
        this.queueCallback(request.idempotencyKey, providerReference, 'SUCCESS', 2);
        return { outcome: 'INDETERMINATE', providerReference, message: 'Awaiting callback', simulated: true };

      case 'DELAYED_SUCCESS':
      case 'DELAYED_FAILURE':
      case 'TIMEOUT':
        return { outcome: 'INDETERMINATE', providerReference, message: 'No response yet', simulated: true };

      default: {
        const exhaustive: never = behaviour;
        return exhaustive;
      }
    }
  }

  async getStatus(query: ProviderStatusQuery): Promise<ProviderStatus> {
    if (this.options.statusOverride !== undefined) {
      return {
        outcome: this.options.statusOverride,
        providerReference: query.providerReference ?? this.reference(query.idempotencyKey),
        simulated: true,
      };
    }

    const record = this.submissions.get(query.idempotencyKey);
    if (!record) {
      return { outcome: 'UNKNOWN_REFERENCE', simulated: true };
    }

    const { behaviour, providerReference } = record;
    const elapsed = this.tick - record.submittedAtTick;
    const delay = this.options.delayTicks ?? 1;

    switch (behaviour) {
      case 'SUCCESS':
      case 'DUPLICATE_CALLBACK':
        return { outcome: 'SUCCESS', providerReference, simulated: true };

      case 'FAILURE':
        return { outcome: 'FAILURE', providerReference, simulated: true };

      case 'DELAYED_SUCCESS':
        return elapsed >= delay
          ? { outcome: 'SUCCESS', providerReference, simulated: true }
          : { outcome: 'STILL_PENDING', providerReference, simulated: true };

      case 'DELAYED_FAILURE':
        return elapsed >= delay
          ? { outcome: 'FAILURE', providerReference, simulated: true }
          : { outcome: 'STILL_PENDING', providerReference, simulated: true };

      case 'TIMEOUT':
      case 'MALFORMED_RESPONSE':
        // Never resolves on its own. This is what drives a transaction into
        // UNDER_REVIEW once the pending maximum elapses.
        return { outcome: 'STILL_PENDING', providerReference, simulated: true };

      case 'OUTAGE':
        return { outcome: 'UNKNOWN_REFERENCE', simulated: true };

      default: {
        const exhaustive: never = behaviour;
        return exhaustive;
      }
    }
  }

  async reverse(request: ProviderReversalRequest): Promise<ProviderReversalResult> {
    const known = [...this.submissions.values()].some(
      (record) => record.providerReference === request.providerReference,
    );
    return {
      accepted: known,
      providerReference: request.providerReference,
      message: known ? 'Reversal accepted (simulated)' : 'Unknown provider reference',
      simulated: true,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const unhealthy = this.options.behaviour === 'OUTAGE';
    return {
      healthy: !unhealthy,
      providerId: this.options.providerId,
      message: unhealthy ? 'Simulated provider outage' : 'Simulated provider healthy',
      simulated: true,
    };
  }

  private queueCallback(
    idempotencyKey: string,
    providerReference: string,
    outcome: 'SUCCESS' | 'FAILURE',
    deliveries: number,
  ): void {
    const deliveryOf = `${providerReference}-1`;
    for (let i = 0; i < deliveries; i += 1) {
      this.pendingCallbacks.push({
        idempotencyKey,
        providerReference,
        outcome,
        simulated: true,
        deliveryId: `${deliveryOf}-d${String(i + 1)}`,
        // Identical across duplicates: this is the same logical callback
        // delivered twice, which the webhook handler must apply only once.
        deliveryOf,
      });
    }
  }

  /** Drain the callbacks the provider would have delivered. */
  drainCallbacks(): readonly MockCallback[] {
    const drained = [...this.pendingCallbacks];
    this.pendingCallbacks.length = 0;
    return Object.freeze(drained);
  }

  /** Callbacks without draining, for assertions. */
  peekCallbacks(): readonly MockCallback[] {
    return Object.freeze([...this.pendingCallbacks]);
  }

  submissionCount(idempotencyKey: string): number {
    return this.submissions.get(idempotencyKey)?.seen ?? 0;
  }
}
