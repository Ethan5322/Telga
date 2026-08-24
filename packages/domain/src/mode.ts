/**
 * Operating mode.
 *
 * Telga runs in TRAINING mode only. `assertSimulated` is the structural guard
 * that keeps it that way: the domain refuses to construct a transaction or post
 * a ledger entry marked LIVE, so enabling live money is not a matter of
 * flipping a flag in a config file.
 *
 * See `07 Governance/Launch Gates.md` — 0 of 10 gates are cleared — and
 * `02 Product/Feature Flags.md` for the dual approval that would be required.
 */

import { LiveMoneyDisabledError } from './errors';

export type OperatingMode = 'TRAINING' | 'LIVE';

/** The only mode this build supports. */
export const CURRENT_MODE: OperatingMode = 'TRAINING';

/** The banner every screen carries while training mode is on. */
export const TRAINING_BANNER = 'TRAINING MODE — NO REAL VALUE';

export const isSimulated = (mode: OperatingMode): boolean => mode === 'TRAINING';

/**
 * Throw unless the mode is simulated.
 *
 * Called from every value-bearing constructor in the domain. This is deliberately
 * an error rather than a silent downgrade: code that asks for LIVE has made an
 * assumption that is wrong, and should fail loudly.
 */
export function assertSimulated(mode: OperatingMode): void {
  if (mode !== 'TRAINING') {
    throw new LiveMoneyDisabledError();
  }
}
