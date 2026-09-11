/**
 * Recording what an administrator did.
 *
 * ## Why this exists
 *
 * The console banner says *"Every action here is recorded."* Until this module
 * it did not: the console read `audit_events` to draw the audit screen and
 * wrote nothing to it, so the screen was a window onto the POS's trail with an
 * admin heading over it. A claim on a banner that the system does not keep is
 * worse than no banner, because it is what an operator relies on when deciding
 * whether an action is safe to take.
 *
 * ## Why it writes directly rather than through the ledger driver
 *
 * The driver's `saveAuditEvent` takes a domain `AuditEvent`, whose actor is a
 * merchant operator with a `MerchantId`. An admin has neither — a Platform
 * Owner belongs to no merchant, and `merchant_id` is nullable precisely so
 * platform-level events can exist. Forcing an admin through that shape would
 * mean inventing a merchant for them, which is exactly the sort of fiction the
 * audit trail exists to prevent.
 *
 * ## What is deliberately not recorded
 *
 * No password, no TOTP secret, no code, no session token, no enrollment token.
 * The metadata below is limited to identifiers and outcomes. An audit trail
 * that carries credentials turns every reader of the audit screen into a
 * holder of them.
 */

import type { AdminRole } from '@telga/domain';
import type { ConsoleDb } from './server';

/** What an admin did. Past tense, because it has already happened. */
export type AdminAuditEvent =
  | 'ADMIN_SIGNED_IN'
  | 'ADMIN_SIGN_IN_REFUSED'
  /**
   * A sign-in code was emailed — §23.1.
   *
   * Recorded because a code going out is the moment somebody's password was
   * accepted. A run of these against one account, with no matching
   * `ADMIN_SIGNED_IN`, is a password that is already known to somebody who
   * cannot read the inbox.
   *
   * Never carries the code, and never the address beyond the row the actor id
   * already names.
   */
  | 'ADMIN_OTP_SENT'
  /** A wrong code. Counted against the code, never the account. */
  | 'ADMIN_OTP_REFUSED'
  /** The second factor was satisfied and the session is fully live. */
  | 'ADMIN_OTP_ACCEPTED'
  | 'ADMIN_SIGNED_OUT'
  | 'ADMIN_MFA_ENROLLED'
  | 'ADMIN_MFA_CONFIRMED'
  | 'ADMIN_MFA_REFUSED'
  | 'ADMIN_MFA_RESET'
  | 'ADMIN_STEPPED_UP'
  | 'ADMIN_STEP_UP_REFUSED'
  /** An admin recorded a registration taken at a shop. Creates no account. */
  | 'ADMIN_APPLICATION_RECORDED'
  /**
   * Somebody opened a scanned identity document.
   *
   * Its own event because R37 requires that "who looked at whose passport" be
   * answerable. Written **before** the bytes are sent, so a read that happened
   * is recorded even if the response never completes.
   */
  | 'ADMIN_DOCUMENT_VIEWED'
  /**
   * Sign-in parameters were generated for a shop.
   *
   * Records the operator and device ids, which are not secrets. The device key
   * and PIN are never recorded anywhere — they exist in the response that shows
   * them and nowhere else.
   */
  | 'ADMIN_CREDENTIALS_ISSUED'
  /**
   * A deposit was recorded and decided.
   *
   * Carries the outcome and the bank's reference. **Never the quoted
   * reference** — under D125 that is the shop's device key, and an audit screen
   * carrying it would hand a credential to every reader of the trail.
   */
  | 'ADMIN_DEPOSIT_RECORDED'
  /**
   * A **second** person approved a high-value deposit — §20.
   *
   * Separate from `ADMIN_DEPOSIT_RECORDED` because they are two acts by two
   * people, and the control only means something if the trail can show they
   * were different people.
   */
  | 'ADMIN_FUNDING_SECOND_APPROVED'
  /**
   * A shop was stopped from selling, or allowed to again.
   *
   * The reason is recorded on the suspension, because it is the thing an
   * operator will be asked about — by the shop, and possibly later by somebody
   * reviewing why a business lost a day's trade.
   */
  | 'ADMIN_MERCHANT_SUSPENDED'
  | 'ADMIN_MERCHANT_REINSTATED'
  /** One device stopped and its sessions revoked. The shop's others carry on. */
  | 'ADMIN_DEVICE_STOPPED'
  /**
   * A stopped device returned to service.
   *
   * Not the inverse of a stop: the device row becomes ACTIVE again and its
   * **enrolment stays revoked**, so the shop must pair it with a new activation
   * code. The trail records the reinstatement; the re-pairing has its own event.
   */
  | 'ADMIN_DEVICE_REINSTATED'
  /**
   * One **operator** stopped, and their sessions revoked. The shop's other
   * operators carry on — the same shape as stopping one device rather than
   * suspending a merchant, one level further in.
   */
  | 'ADMIN_OPERATOR_SUSPENDED'
  | 'ADMIN_OPERATOR_REINSTATED'
  /**
   * A temporary PIN issued for an operator who had lost theirs.
   *
   * The event records **that** it happened and who did it, never the PIN. An
   * audit trail carrying credentials turns every reader of the audit screen
   * into a holder of them.
   */
  | 'ADMIN_OPERATOR_PIN_RESET'
  /**
   * An administrator checked a device key a shop read out to them.
   *
   * Records that the check happened and what it said — never the key. A device
   * key cannot be displayed by Telga at all, so this is the only way a support
   * call can confirm a shop holds the right one.
   */
  | 'ADMIN_DEVICE_KEY_CHECKED'
  /**
   * A merchant's individual transaction was read, inside an open case.
   *
   * D144 limits Telga staff to aggregates. This is the exception, and it exists
   * because §17 cannot be answered without it — so every use is recorded, with
   * the case reference it was read under. Never the recipient.
   */
  | 'ADMIN_CASE_TRANSACTION_VIEWED'
  | 'ADMIN_COMPLAINT_DECIDED'
  /**
   * A supervisor decided a merchant's reversal request — §17.1.
   *
   * The **authorisation**, recorded separately from the ledger entry it
   * authorises. §13 invariant 8: a correction is an authorised adjustment, and
   * the authorisation has to be visible on its own.
   */
  | 'ADMIN_REVERSAL_APPROVED'
  | 'ADMIN_REVERSAL_REFUSED'
  | 'ADMIN_APPLICATION_PICKED_UP'
  | 'ADMIN_APPLICATION_DECIDED'
  | 'ADMIN_ENROLLMENT_TOKEN_ISSUED'
  | 'ADMIN_CREATED'
  | 'ADMIN_MERCHANT_PROVISIONED'
  /**
   * Approval succeeded and provisioning did not.
   *
   * Its own event rather than a field on the success one: the two are read for
   * different reasons. A refused provisioning leaves an approved application
   * with no shop behind it, which is a state somebody has to resolve, and it
   * should be findable without reading the metadata of every provisioning.
   */
  | 'ADMIN_MERCHANT_PROVISION_REFUSED';

export interface AdminAuditInput {
  readonly event: AdminAuditEvent;
  /** The admin who acted. `unknown` when sign-in failed before identifying one. */
  readonly actorId: string;
  readonly actorRole: AdminRole | 'ANONYMOUS';
  readonly entityType: string;
  readonly entityId?: string;
  /** Set only when the action was about one merchant. */
  readonly merchantId?: string;
  readonly correlationId: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Append one admin action to the shared trail.
 *
 * Never throws. An audit write that fails must not take the action down with
 * it — but it must not pass silently either, so the failure goes to stderr
 * where the operator running the console will see it. That is a deliberate
 * trade: for Telga's threat model, losing a console action is worse than
 * losing its audit line, and the alternative (refusing the action) hands
 * anyone who can break the audit write a way to stop admins working.
 */
export function recordAdminAction(
  db: ConsoleDb,
  newId: (prefix: string) => string,
  now: () => string,
  input: AdminAuditInput,
): void {
  try {
    db.prepare(
      `INSERT INTO audit_events (
         id, actor_type, actor_id, event_type, entity_type, entity_id,
         merchant_id, correlation_id, metadata, created_at)
       VALUES (@id, @actorType, @actorId, @eventType, @entityType, @entityId,
         @merchantId, @correlationId, @metadata, @createdAt)`,
    ).run({
      id: newId('aud'),
      actorType: input.actorRole,
      actorId: input.actorId,
      eventType: input.event,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      merchantId: input.merchantId ?? null,
      correlationId: input.correlationId,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      createdAt: now(),
    });
  } catch (error) {
    process.stderr.write(
      `AUDIT WRITE FAILED for ${input.event}: ` +
        `${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
  }
}
