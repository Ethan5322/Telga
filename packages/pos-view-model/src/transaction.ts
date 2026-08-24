/**
 * The transaction view model.
 *
 * One pure function turns a `TransactionDto` into everything a screen needs:
 * label, explanation, funds status, permitted actions, refusals, refresh
 * behaviour, recovery summary and support reference.
 *
 * Nothing here recomputes anything the server owns. Balance, state and ledger
 * position arrive already decided; this file only chooses how to *say* them.
 */

import type { TransactionState } from '@telga/domain';
import { AMHARIC_REVIEW_WARNING, t, translate } from '@telga/localization';
import type { Locale, MessageKey } from '@telga/localization';
import type { RecoveryDto, TransactionDto } from './dto';
import { fundsStatusFor, presentationFor } from './presentation';
import type {
  FundsStatus,
  ForbiddenAction,
  MerchantAction,
  OutcomeCertainty,
  RefreshBehaviour,
  StatePresentation,
  SupportEscalation,
  Tone,
} from './presentation';

/** What the recovery panel shows. Plain sentences, no worker internals. */
export interface RecoverySummary {
  /** `NOT_APPLICABLE` when the transaction never went pending. */
  readonly phase:
    | 'NOT_APPLICABLE'
    | 'AWAITING_RECOVERY'
    | 'BEING_CHECKED_NOW'
    | 'ESCALATED'
    | 'RESOLVED';
  readonly attempts: number;
  readonly maxAttempts: number | null;
  readonly lastAttemptAt: string | null;
  readonly nextCheckAt: string | null;
  readonly deadlineAt: string | null;
  /** Safe category, or null. Never a provider message. */
  readonly lastOutcomeCategory: string | null;
  readonly manualReviewOpen: boolean;
}

export interface TransactionViewModel {
  readonly transactionId: string;
  /** The domain state, verbatim. Never renamed. */
  readonly state: TransactionState;
  readonly statusLabel: string;
  readonly statusExplanation: string;
  readonly tone: Tone;
  readonly icon: string;
  readonly certainty: OutcomeCertainty;
  readonly fundsStatus: FundsStatus;
  readonly fundsLabel: string;
  readonly amountFormatted: string;
  readonly recipientMasked: string;
  readonly providerReference: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly allowedActions: readonly MerchantAction[];
  readonly forbiddenActions: readonly ForbiddenAction[];
  readonly refresh: RefreshBehaviour;
  readonly supportEscalation: SupportEscalation;
  readonly supportReference: string | null;
  readonly doNotRetryYet: boolean;
  readonly receiptAvailable: boolean;
  readonly recovery: RecoverySummary;
  readonly trainingMode: boolean;
  /** Set when a label had no translation in `locale` and English was used. */
  readonly untranslated: readonly MessageKey[];
  readonly localeWarning: string | null;
}

/**
 * How the merchant's money is described, per funds status.
 *
 * These are deliberately plain. "Held" is not "charged", and "released" is not
 * "refunded" — a refund implies money left and came back, which is not what a
 * released reservation is.
 */
const FUNDS_LABEL: Readonly<Record<FundsStatus, string>> = Object.freeze({
  NOT_YET_COMMITTED: 'No money committed yet',
  HELD: 'Your money is held for this sale',
  HELD_UNDER_REVIEW: 'Your money is held while this is checked',
  DEBITED: 'Your balance was reduced for this sale',
  RELEASED: 'Your money was returned to your available balance',
});

function recoveryPhase(recovery: RecoveryDto, state: TransactionState): RecoverySummary['phase'] {
  if (recovery.pendingStatus === null) return 'NOT_APPLICABLE';
  if (recovery.pendingStatus === 'RESOLVED') return 'RESOLVED';
  if (recovery.pendingStatus === 'ESCALATED') return 'ESCALATED';
  if (recovery.claimActive) return 'BEING_CHECKED_NOW';
  // AWAITING with no live claim: a worker will pick it up on the next sweep.
  return state === 'UNDER_REVIEW' ? 'ESCALATED' : 'AWAITING_RECOVERY';
}

export function toRecoverySummary(
  recovery: RecoveryDto,
  state: TransactionState,
): RecoverySummary {
  return {
    phase: recoveryPhase(recovery, state),
    attempts: recovery.attempts,
    maxAttempts: recovery.maxAttempts,
    lastAttemptAt: recovery.lastAttemptAt,
    nextCheckAt: recovery.nextCheckAt,
    deadlineAt: recovery.deadlineAt,
    lastOutcomeCategory: recovery.lastOutcomeCategory,
    manualReviewOpen: recovery.manualReviewStatus === 'OPEN',
  };
}

export function toTransactionViewModel(
  dto: TransactionDto,
  locale: Locale = 'en',
): TransactionViewModel {
  const presentation: StatePresentation = presentationFor(dto.state);
  const label = translate(locale, presentation.labelKey);
  const explanation = translate(locale, presentation.explanationKey);
  const fundsStatus = fundsStatusFor(dto.state);

  const untranslated: MessageKey[] = [];
  if (label.fellBackToEnglish) untranslated.push(presentation.labelKey);
  if (explanation.fellBackToEnglish) untranslated.push(presentation.explanationKey);

  return {
    transactionId: dto.transactionId,
    state: dto.state,
    statusLabel: label.text,
    statusExplanation: explanation.text,
    tone: presentation.tone,
    icon: presentation.icon,
    certainty: presentation.certainty,
    fundsStatus,
    fundsLabel: FUNDS_LABEL[fundsStatus],
    amountFormatted: dto.amount.formatted,
    recipientMasked: dto.recipientMasked,
    providerReference: dto.providerReference,
    correlationId: dto.correlationId,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    allowedActions: presentation.allowedActions,
    forbiddenActions: presentation.forbiddenActions,
    refresh: presentation.refresh,
    supportEscalation: presentation.supportEscalation,
    supportReference: dto.support?.reference ?? null,
    doNotRetryYet: presentation.doNotRetryYet,
    receiptAvailable: presentation.receiptAvailable,
    recovery: toRecoverySummary(dto.recovery, dto.state),
    trainingMode: dto.mode === 'TRAINING',
    untranslated,
    localeWarning: locale === 'am' ? AMHARIC_REVIEW_WARNING : null,
  };
}

/**
 * The single instruction line for an in-flight or uncertain transaction.
 *
 * Returned separately from the explanation because it is the one sentence that
 * must not be scrolled past.
 */
export function retryInstruction(view: TransactionViewModel, locale: Locale = 'en'): string | null {
  return view.doNotRetryYet ? t(locale, 'status.pending.do_not_retry') : null;
}

/** True when the given action is permitted for this transaction. */
export function permits(view: TransactionViewModel, action: MerchantAction): boolean {
  return view.allowedActions.includes(action);
}

/** True when the given action is explicitly refused, not merely unlisted. */
export function refuses(view: TransactionViewModel, action: ForbiddenAction): boolean {
  return view.forbiddenActions.includes(action);
}
