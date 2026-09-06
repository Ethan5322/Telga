/**
 * Receipt lookup and reprint.
 *
 * **Ledger invariant 5: a reprint never creates a sale.** That is enforced
 * structurally here, not by care: this module has no access to `createSale`,
 * posts no ledger entry, touches no reservation, and changes no transaction
 * state. The only write it performs is an append-only audit event. Read the
 * imports — there is nothing here that could move value even if a caller
 * asked it to.
 *
 * The original transaction is the single source of truth for every field on
 * the slip, so a reprint on any later day still prints the amount, the
 * reference and the timestamp the sale actually had.
 */

import {
  auditEventId,
  parseProductId,
  productLabelFor,
  simulatedVoucherCode,
  createAuditEvent,
  createReceipt,
  format,
  money,
  receiptAvailable,
  recordReprint,
  receiptId as toReceiptId,
  transactionId as toTransactionId,
} from '@telga/domain';
import type {
  MerchantId,
  Receipt,
  TransactionState,
} from '@telga/domain';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

/**
 * What a slip shows.
 *
 * Deliberately **not** the transaction row. A row carries a recipient hash, a
 * payload fingerprint and an idempotency key; none of those belong on paper
 * handed across a counter, so this type simply has nowhere to put them.
 */
export interface ReceiptDto {
  readonly transactionId: string;
  readonly merchantId: string;
  readonly service: string;
  readonly network: string | null;
  readonly amountFormatted: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly state: TransactionState;
  /** Masked at write time by the persistence layer; never the full number. */
  readonly recipientMasked: string;
  readonly providerReference: string | null;
  readonly supportContact: string;
  readonly trainingBanner: string;
  /** False on the original, true on every reprint. Printed on the slip. */
  readonly isReprint: boolean;
  /** 0 for the original; 1 for the first reprint, and so on. */
  readonly reprintSequence: number;
  /**
   * Simulated redemption details, for the products that have any (airtime
   * and data vouchers — a direct top-up goes straight to a phone and needs
   * no code to hand over).
   *
   * Derived, not stored: `simulatedVoucherCode()` is a pure function of the
   * transaction id, so a reprint prints exactly what the first slip printed.
   * Every value is deliberately, visibly fake — see that function.
   *
   * Named `redemptionCode` rather than `voucherPin` on purpose. It is the
   * number a customer dials, not an authentication secret — but
   * `assertSafeForDisplay` refuses any key containing "pin", and that guard
   * is far more valuable blunt than clever. The slip still *labels* it
   * "Voucher PIN", which is what a merchant calls it.
   */
  readonly redemptionCode: string | null;
  readonly redemptionReference: string | null;
  readonly dialString: string | null;
  readonly networkCode: string | null;
}

export type ReceiptResult =
  | { readonly kind: 'FOUND'; readonly receipt: ReceiptDto }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_ELIGIBLE'; readonly state: TransactionState };

const TRAINING_BANNER = 'TRAINING — NO REAL VALUE';

/**
 * The support line printed on every receipt.
 *
 * `04 UX UI/Receipt Specification` requires a support contact, and a receipt is
 * the one artefact that leaves the shop in a customer's hand — so this text has
 * to be true off the machine as well as on it.
 *
 * It carries **no phone number**, deliberately. A number shaped like a real
 * Ethiopian one that rings nowhere is worse than an obvious absence, and worse
 * still if the digits ever reach a real subscriber. `.example` is reserved by
 * RFC 2606 and can never be registered, so the address cannot start resolving
 * to somebody else's mail server.
 *
 * Replacing this is a launch gate — CLAUDE.md §8, *"support escalation
 * assigned"* — not a text edit.
 */
export const SUPPORT_CONTACT =
  'Telga training support — support@telga.example (not staffed)';

/**
 * How many times this transaction has already been reprinted.
 *
 * Counted from the append-only audit trail rather than stored on the
 * transaction, so the sequence needs no schema change and cannot drift from
 * the events that produced it.
 */
function reprintCount(deps: AuthedApiDeps, transactionId: string): number {
  return deps.driver.countAuditEvents('RECEIPT_REPRINTED', transactionId);
}

/**
 * Load a transaction for this merchant, or refuse.
 *
 * Scoped in SQL by the **session's** merchant, so a transaction belonging to
 * another shop and one that does not exist are indistinguishable.
 */
function loadForContext(
  deps: AuthedApiDeps,
  context: AuthContext,
  transactionId: string,
): ReturnType<AuthedApiDeps['driver']['findTransaction']> {
  if (transactionId.trim().length === 0) return undefined;
  return deps.driver.findTransaction(toTransactionId(transactionId), context.merchantId);
}

function toDto(
  row: NonNullable<ReturnType<AuthedApiDeps['driver']['findTransaction']>>,
  receipt: Receipt,
  reprintSequence: number,
): ReceiptDto {
  return {
    transactionId: row.id,
    merchantId: row.merchant_id,
    // A readable product name, not a database key. `parseProductId` anchors
    // on the product kind rather than splitting on the first underscore,
    // which used to truncate `NETWORK_A` to `NETWORK`.
    service: productLabelFor(row.product_type),
    network: parseProductId(row.product_type)?.network ?? null,
    // Formatted by the domain's own money formatter, so the slip, the screen
    // and the ledger all agree on presentation.
    amountFormatted: format(receipt.amount),
    currency: row.currency,
    issuedAt: row.created_at,
    state: row.state,
    recipientMasked: displayableRecipient(row.recipient_masked),
    providerReference: row.provider_reference,
    supportContact: SUPPORT_CONTACT,
    trainingBanner: TRAINING_BANNER,
    isReprint: reprintSequence > 0,
    reprintSequence,
    ...redemptionFor(row),
  };
}

/**
 * A recipient worth printing, or an empty string.
 *
 * Voucher sales written before the recipient fix carry the *mask of a
 * placeholder* — `VOUCHER-SALE-NO-RECIPIENT` masked down to
 * `VO*********************NT`. On paper that is a row of twenty-one stars
 * where a phone number should be, on a product that never had one, and it
 * was being read as a masked voucher PIN.
 *
 * New sales store an empty mask instead, so this only ever fires for rows
 * already in the database. It is a read-time fix rather than a migration
 * because the transaction table is history: rewriting what those rows say
 * happened would be worse than declining to print a value that was never
 * real. Nothing is lost — there was no phone number to lose.
 */
function displayableRecipient(masked: string): string {
  const trimmed = masked.trim();
  if (trimmed.length === 0) return '';
  // Anything that is only mask characters carries no information.
  if (/^[*]+$/.test(trimmed)) return '';
  // The legacy placeholder, whatever mask parameters produced it.
  if (/^VO[*]+NT$/.test(trimmed)) return '';
  return trimmed;
}

/**
 * The simulated redemption details, for products that have any.
 *
 * A **top-up** deliberately has none: the airtime lands on the customer's
 * phone directly, so there is no code to hand across a counter, and printing
 * one would invite somebody to try to redeem it. Airtime and data vouchers
 * get one, because that is the whole thing the customer is buying.
 */
function redemptionFor(row: { id: string; product_type: string }): {
  redemptionCode: string | null;
  redemptionReference: string | null;
  dialString: string | null;
  networkCode: string | null;
} {
  const parsed = parseProductId(row.product_type);
  // A top-up has no code on purpose: the airtime lands on the customer's
  // phone directly, so there is nothing to hand over, and printing a code
  // would invite somebody to try to redeem it. A legacy `/sell` sale parses
  // to `undefined` and is treated the same way.
  if (parsed === undefined || parsed.kind === 'TOPUP') {
    return { redemptionCode: null, redemptionReference: null, dialString: null, networkCode: null };
  }
  const code = simulatedVoucherCode(row.id, parsed.network);
  return {
    redemptionCode: code.voucherPin,
    redemptionReference: code.tokenReference,
    dialString: code.dialString,
    networkCode: code.networkCode,
  };
}

/** Read a receipt. Writes nothing at all — not even an audit event. */
export function lookupReceipt(
  deps: AuthedApiDeps,
  context: AuthContext,
  transactionId: string,
): ReceiptResult {
  const row = loadForContext(deps, context, transactionId);
  if (!row) return { kind: 'NOT_FOUND' };

  const state = row.state;
  if (!receiptAvailable(state)) return { kind: 'NOT_ELIGIBLE', state };

  const sequence = reprintCount(deps, row.id);
  const receipt = createReceipt({
    id: toReceiptId(`rcpt_${row.id}`),
    transactionId: toTransactionId(row.id),
    merchantId: row.merchant_id as MerchantId,
    merchantName: row.merchant_id,
    productLabel: row.product_type,
    amount: money(row.amount_minor),
    recipient: row.recipient_masked,
    providerReference: row.provider_reference ?? undefined,
    state,
    issuedAt: row.created_at as never,
    supportContact: SUPPORT_CONTACT,
    isReprint: sequence > 0,
    trainingBanner: TRAINING_BANNER,
  });

  return { kind: 'FOUND', receipt: toDto(row, receipt, sequence) };
}

/**
 * Record a reprint and return the slip.
 *
 * `recordReprint` returns an event and nothing else — it takes no ledger and
 * returns no transaction, so this function has no way to produce a sale even
 * by mistake. The audit event is the only durable effect.
 */
export function reprintReceipt(
  deps: AuthedApiDeps,
  context: AuthContext,
  transactionId: string,
  correlationId: string,
): ReceiptResult {
  const row = loadForContext(deps, context, transactionId);
  if (!row) return { kind: 'NOT_FOUND' };

  const state = row.state;
  if (!receiptAvailable(state)) return { kind: 'NOT_ELIGIBLE', state };

  const sequence = reprintCount(deps, row.id) + 1;
  const event = recordReprint({
    id: auditEventId(deps.newId('audit')),
    transactionId: toTransactionId(row.id),
    merchantId: row.merchant_id as MerchantId,
    operatorId: context.userId,
    deviceId: context.deviceId,
    at: deps.now(),
    sequence,
  });

  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: event.id,
      at: event.at,
      action: 'RECEIPT_REPRINTED',
      actor: { userId: event.operatorId, role: context.role, deviceId: event.deviceId },
      merchantId: event.merchantId,
      transactionId: event.transactionId,
      // A safe code and a count. No PIN, no token, no device key.
      detail: `REPRINT_SEQUENCE_${String(sequence)}`,
    }),
    correlationId,
    entityType: 'transaction',
    entityId: row.id,
  });

  const receipt = createReceipt({
    id: toReceiptId(`rcpt_${row.id}_${String(sequence)}`),
    transactionId: toTransactionId(row.id),
    merchantId: row.merchant_id as MerchantId,
    merchantName: row.merchant_id,
    productLabel: row.product_type,
    amount: money(row.amount_minor),
    recipient: row.recipient_masked,
    providerReference: row.provider_reference ?? undefined,
    state,
    // The **original** timestamp. A reprint never restamps the sale.
    issuedAt: row.created_at as never,
    supportContact: SUPPORT_CONTACT,
    isReprint: true,
    trainingBanner: TRAINING_BANNER,
  });

  return { kind: 'FOUND', receipt: toDto(row, receipt, sequence) };
}
