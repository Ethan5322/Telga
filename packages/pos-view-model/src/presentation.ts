/**
 * The state-to-UI mapping.
 *
 * This is the single place that decides what a merchant may see and do for a
 * given transaction state, and it is a **table, not control flow** — the same
 * shape as `VALID_TRANSITIONS` in the domain, and testable the same way.
 *
 * ## The rules this table exists to enforce
 *
 * 1. **No state that holds value may look like a completed sale.** Only
 *    `SUCCESSFUL` carries `CERTAIN_SUCCESS`, and only `SUCCESSFUL` permits a
 *    receipt.
 * 2. **An uncertain outcome names itself.** `PROCESSING`, `PENDING`,
 *    `UNDER_REVIEW` and `REVERSAL_REQUIRED` all forbid retry, and each carries
 *    `doNotRetryYet`.
 * 3. **Funds status is derived from the domain, never restated.**
 *    `fundsStatusFor` reads `VALUE_DISPOSITION`, so the UI cannot claim funds
 *    are released while the ledger still holds them.
 * 4. **Status is never colour alone** — every entry carries a `tone`, an
 *    `icon` and a text label, per `04 UX UI/Design System.md`.
 *
 * Domain state names are used verbatim. Nothing here renames a state; the label
 * is a separate, translated field beside it.
 */

import { TRANSACTION_STATES, VALUE_DISPOSITION, isTerminal } from '@telga/domain';
import type { TransactionState, ValueDisposition } from '@telga/domain';
import type { MessageKey } from '@telga/localization';

/** Where the merchant's value sits. A presentation word for `ValueDisposition`. */
export type FundsStatus =
  | 'NOT_YET_COMMITTED'
  | 'HELD'
  | 'HELD_UNDER_REVIEW'
  | 'DEBITED'
  | 'RELEASED';

/**
 * How sure Telga is about what the provider did.
 *
 * Separate from the state on purpose: the merchant's question is not "which
 * state is this" but "do I know whether the customer got their airtime".
 */
export type OutcomeCertainty =
  | 'IN_PROGRESS'
  | 'UNCERTAIN'
  | 'AWAITING_DETERMINATION'
  | 'CERTAIN_SUCCESS'
  | 'CERTAIN_NO_SALE';

/** Actions the POS may offer. Every one is read-only or navigational. */
export type MerchantAction =
  | 'VIEW_DETAIL'
  | 'REFRESH_STATUS'
  | 'PRINT_RECEIPT'
  | 'REPRINT_RECEIPT'
  | 'START_NEW_SALE'
  | 'CONTACT_SUPPORT'
  | 'COPY_SUPPORT_REFERENCE'
  | 'BACK_TO_HOME';

/** Named so a test can assert the refusal, not merely the absence of a button. */
export type ForbiddenAction =
  | 'RETRY_SAME_SALE'
  | 'PRINT_RECEIPT'
  | 'TREAT_AS_SUCCESSFUL'
  | 'TREAT_AS_FAILED'
  | 'RELEASE_FUNDS'
  | 'CHANGE_STATE';

export type RefreshBehaviour = 'POLL_UNTIL_RESOLVED' | 'MANUAL_ONLY' | 'NONE';

export type SupportEscalation =
  | 'NONE'
  | 'AVAILABLE_ON_REQUEST'
  | 'CASE_OPEN_AUTOMATICALLY'
  | 'CASE_REQUIRED';

/** Text + icon + tone. Colour alone is never the signal. */
export type Tone = 'NEUTRAL' | 'PROGRESS' | 'CAUTION' | 'POSITIVE' | 'NEGATIVE';

export interface StatePresentation {
  readonly state: TransactionState;
  readonly labelKey: MessageKey;
  readonly explanationKey: MessageKey;
  readonly tone: Tone;
  /** A short text marker, so status never depends on colour or on an image. */
  readonly icon: string;
  readonly certainty: OutcomeCertainty;
  readonly allowedActions: readonly MerchantAction[];
  readonly forbiddenActions: readonly ForbiddenAction[];
  readonly refresh: RefreshBehaviour;
  readonly supportEscalation: SupportEscalation;
  /** True when the POS must show the "do not retry yet" instruction prominently. */
  readonly doNotRetryYet: boolean;
  /** True when a receipt may be offered. Only a confirmed sale qualifies. */
  readonly receiptAvailable: boolean;
}

const IN_PROGRESS_ACTIONS: readonly MerchantAction[] = ['VIEW_DETAIL', 'REFRESH_STATUS'];

/** Everything an in-flight transaction forbids. Nothing may be done to it at all. */
const NEVER: readonly ForbiddenAction[] = [
  'RETRY_SAME_SALE',
  'PRINT_RECEIPT',
  'TREAT_AS_SUCCESSFUL',
  'TREAT_AS_FAILED',
  'RELEASE_FUNDS',
  'CHANGE_STATE',
];

const inFlight = (state: TransactionState): StatePresentation => ({
  state,
  labelKey: 'status.processing',
  explanationKey: 'status.processing',
  tone: 'PROGRESS',
  icon: '...',
  certainty: 'IN_PROGRESS',
  allowedActions: IN_PROGRESS_ACTIONS,
  forbiddenActions: NEVER,
  refresh: 'POLL_UNTIL_RESOLVED',
  supportEscalation: 'NONE',
  doNotRetryYet: true,
  receiptAvailable: false,
});

const noSale = (
  state: TransactionState,
  allowedActions: readonly MerchantAction[],
): StatePresentation => ({
  state,
  labelKey: 'status.failed',
  explanationKey: 'status.failed.message',
  tone: 'NEGATIVE',
  icon: 'x',
  certainty: 'CERTAIN_NO_SALE',
  allowedActions,
  forbiddenActions: [
    'RETRY_SAME_SALE',
    'PRINT_RECEIPT',
    'TREAT_AS_SUCCESSFUL',
    'RELEASE_FUNDS',
    'CHANGE_STATE',
  ],
  refresh: 'NONE',
  supportEscalation: 'AVAILABLE_ON_REQUEST',
  doNotRetryYet: false,
  receiptAvailable: false,
});

export const STATE_PRESENTATION: Readonly<Record<TransactionState, StatePresentation>> =
  Object.freeze({
    CREATED: inFlight('CREATED'),
    VALIDATED: inFlight('VALIDATED'),
    // Value is held from RESERVED onward. Nothing below may say "no charge was made".
    RESERVED: inFlight('RESERVED'),
    SUBMITTED: inFlight('SUBMITTED'),
    PROCESSING: inFlight('PROCESSING'),

    PENDING: {
      state: 'PENDING',
      labelKey: 'status.pending',
      explanationKey: 'status.pending.message',
      tone: 'CAUTION',
      icon: '!',
      certainty: 'UNCERTAIN',
      allowedActions: ['VIEW_DETAIL', 'REFRESH_STATUS', 'CONTACT_SUPPORT'],
      forbiddenActions: NEVER,
      refresh: 'POLL_UNTIL_RESOLVED',
      supportEscalation: 'AVAILABLE_ON_REQUEST',
      doNotRetryYet: true,
      receiptAvailable: false,
    },

    UNDER_REVIEW: {
      state: 'UNDER_REVIEW',
      labelKey: 'status.under_review',
      explanationKey: 'status.under_review.message',
      tone: 'CAUTION',
      icon: '?',
      certainty: 'AWAITING_DETERMINATION',
      allowedActions: [
        'VIEW_DETAIL',
        'REFRESH_STATUS',
        'CONTACT_SUPPORT',
        'COPY_SUPPORT_REFERENCE',
      ],
      forbiddenActions: NEVER,
      refresh: 'POLL_UNTIL_RESOLVED',
      supportEscalation: 'CASE_OPEN_AUTOMATICALLY',
      doNotRetryYet: true,
      receiptAvailable: false,
    },

    REVERSAL_REQUIRED: {
      state: 'REVERSAL_REQUIRED',
      labelKey: 'status.under_review',
      explanationKey: 'status.under_review.message',
      tone: 'CAUTION',
      icon: '?',
      certainty: 'AWAITING_DETERMINATION',
      allowedActions: [
        'VIEW_DETAIL',
        'REFRESH_STATUS',
        'CONTACT_SUPPORT',
        'COPY_SUPPORT_REFERENCE',
      ],
      forbiddenActions: NEVER,
      refresh: 'POLL_UNTIL_RESOLVED',
      supportEscalation: 'CASE_REQUIRED',
      doNotRetryYet: true,
      receiptAvailable: false,
    },

    SUCCESSFUL: {
      state: 'SUCCESSFUL',
      labelKey: 'status.successful',
      explanationKey: 'status.successful',
      tone: 'POSITIVE',
      icon: 'ok',
      certainty: 'CERTAIN_SUCCESS',
      allowedActions: ['VIEW_DETAIL', 'PRINT_RECEIPT', 'REPRINT_RECEIPT', 'START_NEW_SALE'],
      forbiddenActions: ['RETRY_SAME_SALE', 'TREAT_AS_FAILED', 'RELEASE_FUNDS', 'CHANGE_STATE'],
      refresh: 'NONE',
      supportEscalation: 'AVAILABLE_ON_REQUEST',
      doNotRetryYet: false,
      receiptAvailable: true,
    },

    FAILED: noSale('FAILED', ['VIEW_DETAIL', 'START_NEW_SALE']),
    REVERSED: noSale('REVERSED', ['VIEW_DETAIL', 'COPY_SUPPORT_REFERENCE', 'START_NEW_SALE']),
    REJECTED: noSale('REJECTED', ['VIEW_DETAIL', 'START_NEW_SALE']),
  });

const FUNDS_BY_DISPOSITION: Readonly<Record<ValueDisposition, FundsStatus>> = Object.freeze({
  NONE: 'NOT_YET_COMMITTED',
  RESERVED: 'HELD',
  UNDER_REVIEW: 'HELD_UNDER_REVIEW',
  DEBITED: 'DEBITED',
  RELEASED: 'RELEASED',
});

/**
 * Funds status, derived from the domain rather than restated here.
 *
 * If `VALUE_DISPOSITION` changes, this follows automatically — which is the
 * point. A second hand-maintained copy would eventually disagree with the
 * ledger, and the merchant would be told the wrong thing about their money.
 */
export function fundsStatusFor(state: TransactionState): FundsStatus {
  return FUNDS_BY_DISPOSITION[VALUE_DISPOSITION[state]];
}

export function presentationFor(state: TransactionState): StatePresentation {
  return STATE_PRESENTATION[state];
}

/** True when the outcome is not yet known. The POS must not imply either result. */
export function isUncertain(state: TransactionState): boolean {
  const certainty = STATE_PRESENTATION[state].certainty;
  return (
    certainty === 'IN_PROGRESS' ||
    certainty === 'UNCERTAIN' ||
    certainty === 'AWAITING_DETERMINATION'
  );
}

/** Every state the POS can be asked to render. */
export const PRESENTABLE_STATES: readonly TransactionState[] = TRANSACTION_STATES;

export { isTerminal };
