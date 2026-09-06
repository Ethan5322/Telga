/**
 * Merchant settings: how a slip prints, and the training profit rate.
 *
 * Three keys, all per-merchant, all read through `context.merchantId` — never
 * from a request. The values are presentation and training figures, not money:
 * nothing here posts a ledger entry, and changing `PROFIT_PERCENT_BPS` changes
 * only what *future* sales credit to `TELGA_REVENUE`. Entries already written
 * carry their own `rule_version`, so a rate change can never rewrite history.
 *
 * The write path is owner-only (`POS_MANAGE_SETTINGS`, declared in the route
 * table). An operator may read the settings — a slip has to print — but may
 * not change the shop's margin or its advertising line.
 */

import type { MerchantId } from '@telga/domain';
import {
  DEFAULT_TRAINING_PROFIT_BPS,
  auditEventId,
  createAuditEvent,
  profitBpsFrom,
} from '@telga/domain';
import type { SettingKey } from '@telga/persistence';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

export type SlipSize = '58' | '80';

export const DEFAULT_SLIP_SIZE: SlipSize = '80';

/** The longest advertising line that still fits a 58 mm roll legibly. */
export const MAX_ADVERT_LENGTH = 120;

export interface SettingsDto {
  readonly slipSize: SlipSize;
  readonly slipAdvert: string;
  readonly profitBps: number;
  /** Percent, for display. Derived from `profitBps`; never stored separately. */
  readonly profitPercent: number;
  /**
   * The shop's own identity, printed on every slip (migration 011).
   *
   * **Telga verifies none of these.** They are what an owner typed, and a TIN
   * or licence number here asserts nothing about registration or compliance —
   * see CLAUDE.md §8. Empty means not filled in, and the line does not print.
   */
  readonly businessName: string;
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly businessTin: string;
  readonly businessLicence: string;
  readonly slipFooter: string;
  /**
   * In-app preferences and local policy (migration 012).
   *
   * All have safe defaults when the row is absent, so a shop that has never
   * opened Settings behaves exactly as it did before they existed. Sound is
   * on, nothing is hidden, and the admin-only options are off — the least
   * surprising state for a machine somebody has just been handed.
   */
  readonly soundEnabled: boolean;
  readonly hideBalance: boolean;
  readonly lowBalanceAlert: boolean;
  readonly statementsAdminOnly: boolean;
  readonly printBarcode: boolean;
  readonly printLookupSlip: boolean;
  /**
   * Named `screenLockEnabled`, not `pinLockEnabled`.
   *
   * `assertSafeForDisplay` refuses any response key containing "pin", and it
   * is right to: that guard is far more valuable blunt than clever. The
   * setting is a screen lock that happens to be released by a PIN, so the
   * honest name is the one that does not trip a secret detector. The screen
   * still *labels* it "Require PIN to unlock", which is what an owner calls it.
   */
  readonly screenLockEnabled: boolean;
  readonly lockSeconds: number;
}

/** Seconds before the screen locks, when no preference is stored. */
export const DEFAULT_LOCK_SECONDS = 60;

const isSlipSize = (value: string): value is SlipSize => value === '58' || value === '80';

/** Newlines and control characters have no business reaching a thermal printer. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function readSettings(deps: AuthedApiDeps, merchantId: MerchantId): SettingsDto {
  // A merchant with no `settings` rows at all is the normal starting state,
  // not an error: every key below falls back to its documented default.
  const stored = new Map(deps.driver.readSettings(merchantId).map((row) => [row.key, row.value]));
  const size = stored.get('SLIP_SIZE');
  const profitBps = profitBpsFrom(stored.get('PROFIT_PERCENT_BPS'));
  return {
    slipSize: size !== undefined && isSlipSize(size) ? size : DEFAULT_SLIP_SIZE,
    slipAdvert: stored.get('SLIP_ADVERT') ?? '',
    profitBps,
    profitPercent: profitBps / 100,
    businessName: stored.get('BUSINESS_NAME') ?? '',
    businessAddress: stored.get('BUSINESS_ADDRESS') ?? '',
    businessPhone: stored.get('BUSINESS_PHONE') ?? '',
    businessTin: stored.get('BUSINESS_TIN') ?? '',
    businessLicence: stored.get('BUSINESS_LICENCE') ?? '',
    slipFooter: stored.get('SLIP_FOOTER') ?? '',
    // `'on'`/`'off'` rather than JSON: the value is written straight from a
    // checkbox and read straight back, with no parsing to get wrong.
    soundEnabled: stored.get('SOUND_ENABLED') !== 'off',
    hideBalance: stored.get('HIDE_BALANCE') === 'on',
    lowBalanceAlert: stored.get('LOW_BALANCE_ALERT') === 'on',
    statementsAdminOnly: stored.get('STATEMENTS_ADMIN_ONLY') === 'on',
    printBarcode: stored.get('PRINT_BARCODE') === 'on',
    printLookupSlip: stored.get('PRINT_LOOKUP_SLIP') === 'on',
    screenLockEnabled: stored.get('PIN_LOCK_ENABLED') === 'on',
    lockSeconds: lockSecondsFrom(stored.get('LOCK_SECONDS')),
  };
}

/**
 * Seconds before the screen locks.
 *
 * Bounded 15–3600 and falling back to the default for anything unparseable,
 * so a stored value that somehow went bad cannot leave a machine that never
 * locks — the failure mode of a lock setting must be *more* locking, not less.
 */
export function lockSecondsFrom(stored: string | undefined): number {
  if (stored === undefined) return DEFAULT_LOCK_SECONDS;
  const parsed = Number(stored);
  if (!Number.isSafeInteger(parsed) || parsed < 15 || parsed > 3600) return DEFAULT_LOCK_SECONDS;
  return parsed;
}

export type WriteSettingsResult =
  | { readonly kind: 'SAVED'; readonly settings: SettingsDto }
  | { readonly kind: 'SLIP_SIZE_INVALID' }
  | { readonly kind: 'ADVERT_INVALID' }
  | { readonly kind: 'PROFIT_INVALID' }
  | { readonly kind: 'LOCK_SECONDS_INVALID' }
  | { readonly kind: 'SIMULATED_ONLY' };

export interface WriteSettingsRequest {
  readonly slipSize?: string;
  readonly slipAdvert?: string;
  /** Percent as typed by the owner, e.g. `"4"` or `"4.5"`. Stored as bps. */
  readonly profitPercent?: string;
  /**
   * The shop's own identity. Each is optional and each is validated the same
   * way the advertisement is — length-bounded, no control characters — because
   * they end up on the same piece of paper.
   */
  readonly businessName?: string;
  readonly businessAddress?: string;
  readonly businessPhone?: string;
  readonly businessTin?: string;
  readonly businessLicence?: string;
  readonly slipFooter?: string;
  /** `'on'` or `'off'`, straight from a checkbox. Absent leaves it unchanged. */
  readonly soundEnabled?: string;
  readonly hideBalance?: string;
  readonly lowBalanceAlert?: string;
  readonly statementsAdminOnly?: string;
  readonly printBarcode?: string;
  readonly printLookupSlip?: string;
  readonly screenLockEnabled?: string;
  /** Seconds, as typed. Bounded 15–3600. */
  readonly lockSeconds?: string;
}

/**
 * Validate and store.
 *
 * Every field is optional: a form that submits only the advertisement leaves
 * the slip size and the profit rate exactly as they were, so one screen cannot
 * silently reset a setting it never showed.
 */
export function writeSettings(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: WriteSettingsRequest,
  correlationId?: string,
): WriteSettingsResult {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const writes: { key: SettingKey; value: string }[] = [];

  if (request.slipSize !== undefined) {
    if (!isSlipSize(request.slipSize)) return { kind: 'SLIP_SIZE_INVALID' };
    writes.push({ key: 'SLIP_SIZE', value: request.slipSize });
  }

  if (request.slipAdvert !== undefined) {
    const advert = request.slipAdvert.trim();
    if (advert.length > MAX_ADVERT_LENGTH) return { kind: 'ADVERT_INVALID' };
    if (CONTROL_CHARACTERS.test(advert)) return { kind: 'ADVERT_INVALID' };
    writes.push({ key: 'SLIP_ADVERT', value: advert });
  }

  if (request.profitPercent !== undefined) {
    const percent = Number(request.profitPercent);
    if (request.profitPercent.trim().length === 0) return { kind: 'PROFIT_INVALID' };
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { kind: 'PROFIT_INVALID' };
    }
    // Percent to basis points, rounded — so `4.005` cannot store a fraction of
    // a basis point that `trainingProfitMinor` would then refuse.
    const bps = Math.round(percent * 100);
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return { kind: 'PROFIT_INVALID' };
    writes.push({ key: 'PROFIT_PERCENT_BPS', value: String(bps) });
  }

  // The corporate fields. Validated exactly as the advertisement is — they
  // end up on the same piece of paper, and a newline in a TIN would break a
  // thermal print the same way one in an advert would. Refused as
  // `ADVERT_INVALID` rather than a per-field code: the screen shows one
  // message for the whole form, and a code per box would be six ways of
  // saying "too long or contains something that cannot print".
  const corporate: readonly (readonly [keyof WriteSettingsRequest, SettingKey])[] = [
    ['businessName', 'BUSINESS_NAME'],
    ['businessAddress', 'BUSINESS_ADDRESS'],
    ['businessPhone', 'BUSINESS_PHONE'],
    ['businessTin', 'BUSINESS_TIN'],
    ['businessLicence', 'BUSINESS_LICENCE'],
    ['slipFooter', 'SLIP_FOOTER'],
  ];
  for (const [field, key] of corporate) {
    const supplied = request[field];
    if (supplied === undefined) continue;
    const value = String(supplied).trim();
    if (value.length > MAX_ADVERT_LENGTH) return { kind: 'ADVERT_INVALID' };
    if (CONTROL_CHARACTERS.test(value)) return { kind: 'ADVERT_INVALID' };
    writes.push({ key, value });
  }

  // The on/off preferences. `'on'` and `'off'` are the only accepted values,
  // so a tampered form cannot store a third state the reader would then have
  // to guess about.
  const toggles: readonly (readonly [keyof WriteSettingsRequest, SettingKey])[] = [
    ['soundEnabled', 'SOUND_ENABLED'],
    ['hideBalance', 'HIDE_BALANCE'],
    ['lowBalanceAlert', 'LOW_BALANCE_ALERT'],
    ['statementsAdminOnly', 'STATEMENTS_ADMIN_ONLY'],
    ['printBarcode', 'PRINT_BARCODE'],
    ['printLookupSlip', 'PRINT_LOOKUP_SLIP'],
    ['screenLockEnabled', 'PIN_LOCK_ENABLED'],
  ];
  for (const [field, key] of toggles) {
    const supplied = request[field];
    if (supplied === undefined) continue;
    // A checkbox submits both its hidden `off` companion and its own `on`,
    // so the last value wins — `on` when ticked, `off` when not.
    const value = String(supplied).split(',').pop()?.trim() === 'on' ? 'on' : 'off';
    writes.push({ key, value });
  }

  if (request.lockSeconds !== undefined) {
    const seconds = Number(request.lockSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 3600) {
      return { kind: 'LOCK_SECONDS_INVALID' };
    }
    writes.push({ key: 'LOCK_SECONDS', value: String(seconds) });
  }

  const now = deps.now();
  for (const write of writes) {
    deps.driver.writeSetting(context.merchantId, write.key, write.value, now);
  }

  // Audited by key, not by value: which settings an owner changed is the fact
  // support needs, and the advertisement line is free text a merchant typed.
  if (writes.length > 0) {
    deps.driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId(deps.newId('audit')),
        at: now,
        action: 'MERCHANT_SETTINGS_CHANGED',
        actor: {
          userId: context.userId,
          role: context.role,
          deviceId: context.deviceId,
        },
        merchantId: context.merchantId,
        detail: writes.map((write) => write.key).join(','),
      }),
      correlationId: correlationId ?? now,
      entityType: 'merchant',
      entityId: context.merchantId,
    });
  }

  return { kind: 'SAVED', settings: readSettings(deps, context.merchantId) };
}

export { DEFAULT_TRAINING_PROFIT_BPS };
