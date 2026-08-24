/**
 * Typed domain errors.
 *
 * Every error carries a stable `code` so callers can branch on the failure
 * without string-matching a message, and so the API layer can map a domain
 * failure onto the merchant-facing string in `04 UX UI/English Strings.md`.
 */

export type DomainErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'TERMINAL_STATE'
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'NEGATIVE_AMOUNT'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'DUPLICATE_IN_PROGRESS'
  | 'INSUFFICIENT_AVAILABLE_BALANCE'
  | 'LEDGER_NOT_BALANCED'
  | 'LEDGER_IMMUTABLE'
  | 'CROSS_MERCHANT_ACCESS'
  | 'LIVE_MONEY_DISABLED'
  | 'COMMISSION_RATE_NOT_CONFIGURED'
  | 'FEE_NOT_CHARGEABLE'
  | 'REPRINT_IS_NOT_A_SALE'
  | 'UNKNOWN_TRANSACTION';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** An attempted state transition that the transition map does not allow. */
export class IllegalTransitionError extends DomainError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('ILLEGAL_TRANSITION', `Illegal transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

/** A transition attempted out of a terminal state. */
export class TerminalStateError extends DomainError {
  readonly from: string;

  constructor(from: string, to: string) {
    super('TERMINAL_STATE', `${from} is terminal; cannot transition to ${to}`);
    this.from = from;
  }
}

/** Money constructed from something that is not a safe integer minor unit. */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super('CURRENCY_MISMATCH', `Cannot combine ${a} with ${b}`);
  }
}

export class NegativeAmountError extends DomainError {
  constructor(message: string) {
    super('NEGATIVE_AMOUNT', message);
  }
}

/**
 * The same idempotency key arrived with a different payload. This is a client
 * bug or an attack, never a legitimate retry — see `03 Domain/Idempotency.md`.
 */
export class IdempotencyPayloadMismatchError extends DomainError {
  readonly key: string;

  constructor(key: string) {
    super('IDEMPOTENCY_PAYLOAD_MISMATCH', `Idempotency key ${key} was reused with a different payload`);
    this.key = key;
  }
}

/** A sale is already in flight under this key; the caller must not start another. */
export class DuplicateInProgressError extends DomainError {
  readonly transactionId: string;

  constructor(key: string, transactionId: string) {
    super('DUPLICATE_IN_PROGRESS', `Idempotency key ${key} is already in progress as ${transactionId}`);
    this.transactionId = transactionId;
  }
}

export class InsufficientAvailableBalanceError extends DomainError {
  constructor(message: string) {
    super('INSUFFICIENT_AVAILABLE_BALANCE', message);
  }
}

/** A posting whose entries do not sum to zero. Ledger invariant 2. */
export class LedgerNotBalancedError extends DomainError {
  readonly residualMinor: number;

  constructor(residualMinor: number) {
    super('LEDGER_NOT_BALANCED', `Posting does not balance; residual ${residualMinor} minor units`);
    this.residualMinor = residualMinor;
  }
}

/** An attempt to mutate ledger history. Ledger invariant 1 and 8. */
export class LedgerImmutableError extends DomainError {
  constructor(message: string) {
    super('LEDGER_IMMUTABLE', message);
  }
}

export class CrossMerchantAccessError extends DomainError {
  constructor(expected: string, actual: string) {
    super('CROSS_MERCHANT_ACCESS', `Merchant ${actual} may not act on data owned by ${expected}`);
  }
}

/**
 * Live money is structurally disabled. No launch gate in
 * `07 Governance/Launch Gates.md` has been cleared, so the domain refuses to
 * operate on anything other than simulated value.
 */
export class LiveMoneyDisabledError extends DomainError {
  constructor() {
    super(
      'LIVE_MONEY_DISABLED',
      'Live money is disabled. Telga runs in TRAINING MODE — NO REAL VALUE until all launch gates are cleared and dual approval is recorded.',
    );
  }
}

/** Commission and fee rates are NOT YET CONFIRMED; computing one is refused. */
export class CommissionRateNotConfiguredError extends DomainError {
  constructor(what: string) {
    super(
      'COMMISSION_RATE_NOT_CONFIGURED',
      `${what} cannot be computed: no rate is confirmed. Rates come from the provider agreement, which does not exist yet.`,
    );
  }
}

/** A fee was attempted on a non-successful outcome. */
export class FeeNotChargeableError extends DomainError {
  constructor(state: string) {
    super('FEE_NOT_CHARGEABLE', `No ordinary fee may be charged on a transaction in state ${state}`);
  }
}

export class ReprintIsNotASaleError extends DomainError {
  constructor(message: string) {
    super('REPRINT_IS_NOT_A_SALE', message);
  }
}

export class UnknownTransactionError extends DomainError {
  constructor(id: string) {
    super('UNKNOWN_TRANSACTION', `No transaction ${id}`);
  }
}
