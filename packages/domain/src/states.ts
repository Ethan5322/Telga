/**
 * Transaction states and the transition map.
 *
 * The transition map is data, not control flow: every legal move is a row in
 * `VALID_TRANSITIONS`, and anything absent from it throws. That is what makes
 * the machine exhaustively testable — see `09 Engineering/Testing Strategy.md`.
 *
 * Two rules here are not negotiable, and both are tested:
 *   1. A timeout is never a failure. `PROCESSING -> PENDING` is the only legal
 *      response to provider silence.
 *   2. No state leaves merchant value unaccounted for. `VALUE_DISPOSITION`
 *      assigns every state exactly one bucket.
 */

import { IllegalTransitionError, TerminalStateError } from './errors';

export const TRANSACTION_STATES = [
  'CREATED',
  'VALIDATED',
  'RESERVED',
  'SUBMITTED',
  'PROCESSING',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
  'SUCCESSFUL',
  'FAILED',
  'REVERSED',
  'REJECTED',
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

/** States from which no further transition is legal. */
export const TERMINAL_STATES = ['SUCCESSFUL', 'FAILED', 'REVERSED', 'REJECTED'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

export const INITIAL_STATE: TransactionState = 'CREATED';

/**
 * Every legal transition, keyed by origin state.
 *
 * `RESERVED` may go to either `SUBMITTED` or `PROCESSING`: an adapter that
 * acknowledges the submission separately passes through `SUBMITTED`, while one
 * that begins awaiting a result immediately goes straight to `PROCESSING`.
 *
 * `PENDING` may reach `REVERSAL_REQUIRED` directly, without passing through
 * `UNDER_REVIEW`: a provider callback can state plainly that value was taken
 * and delivery did not happen, which needs no human determination first.
 */
export const VALID_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> =
  Object.freeze({
    CREATED: Object.freeze(['VALIDATED', 'REJECTED'] as const),
    VALIDATED: Object.freeze(['RESERVED', 'REJECTED'] as const),
    RESERVED: Object.freeze(['SUBMITTED', 'PROCESSING'] as const),
    SUBMITTED: Object.freeze(['PROCESSING'] as const),
    PROCESSING: Object.freeze(['SUCCESSFUL', 'FAILED', 'PENDING'] as const),
    PENDING: Object.freeze(['SUCCESSFUL', 'FAILED', 'UNDER_REVIEW', 'REVERSAL_REQUIRED'] as const),
    UNDER_REVIEW: Object.freeze(['SUCCESSFUL', 'FAILED', 'REVERSAL_REQUIRED'] as const),
    REVERSAL_REQUIRED: Object.freeze(['REVERSED'] as const),
    SUCCESSFUL: Object.freeze([] as const),
    FAILED: Object.freeze([] as const),
    REVERSED: Object.freeze([] as const),
    REJECTED: Object.freeze([] as const),
  });

/**
 * Which balance bucket holds the merchant's value while a transaction sits in
 * each state. Ledger invariant 3 and `03 Domain/Balance Model.md`.
 *
 * NONE        — no value committed yet
 * RESERVED    — held against this transaction, excluded from available
 * UNDER_REVIEW— held pending determination, excluded from available and revenue
 * DEBITED     — value has left the merchant balance; the sale completed
 * RELEASED    — value returned to available
 */
export type ValueDisposition = 'NONE' | 'RESERVED' | 'UNDER_REVIEW' | 'DEBITED' | 'RELEASED';

export const VALUE_DISPOSITION: Readonly<Record<TransactionState, ValueDisposition>> = Object.freeze({
  CREATED: 'NONE',
  VALIDATED: 'NONE',
  RESERVED: 'RESERVED',
  SUBMITTED: 'RESERVED',
  PROCESSING: 'RESERVED',
  PENDING: 'RESERVED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  REVERSAL_REQUIRED: 'UNDER_REVIEW',
  SUCCESSFUL: 'DEBITED',
  FAILED: 'RELEASED',
  REVERSED: 'RELEASED',
  REJECTED: 'RELEASED',
});

export function isTransactionState(value: string): value is TransactionState {
  return (TRANSACTION_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: TransactionState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** True when the transaction still holds merchant value that is not spendable. */
export function holdsMerchantValue(state: TransactionState): boolean {
  const disposition = VALUE_DISPOSITION[state];
  return disposition === 'RESERVED' || disposition === 'UNDER_REVIEW';
}

/** True when a merchant-visible retry must be refused for a transaction in this state. */
export function blocksRetry(state: TransactionState): boolean {
  return !isTerminal(state);
}

export function canTransition(from: TransactionState, to: TransactionState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Throw unless the transition is in the map. Terminal origins get their own error. */
export function assertTransition(from: TransactionState, to: TransactionState): void {
  if (canTransition(from, to)) return;
  if (isTerminal(from)) throw new TerminalStateError(from, to);
  throw new IllegalTransitionError(from, to);
}

/** Every ordered pair the map allows. Used by the exhaustive transition tests. */
export function allValidTransitions(): ReadonlyArray<readonly [TransactionState, TransactionState]> {
  const pairs: Array<readonly [TransactionState, TransactionState]> = [];
  for (const from of TRANSACTION_STATES) {
    for (const to of VALID_TRANSITIONS[from]) {
      pairs.push([from, to] as const);
    }
  }
  return pairs;
}

/** Every ordered pair the map forbids. Used to assert each one throws. */
export function allInvalidTransitions(): ReadonlyArray<readonly [TransactionState, TransactionState]> {
  const pairs: Array<readonly [TransactionState, TransactionState]> = [];
  for (const from of TRANSACTION_STATES) {
    for (const to of TRANSACTION_STATES) {
      if (!canTransition(from, to)) pairs.push([from, to] as const);
    }
  }
  return pairs;
}
