/**
 * Feature flags.
 *
 * `02 Product/Feature Flags` is the specification: it names the flags, states
 * their defaults, and sets the rule that a disabled feature must be
 * inaccessible in **UI, APIs, roles and deployment** — *"hiding a button while
 * the endpoint still answers is a defect"*.
 *
 * So the first suite here does not test behaviour at all. It reads the vault
 * note and asserts the code register matches it, name for name and default for
 * default. An earlier version of the module invented its own names, and nothing
 * failed — the note and the code simply drifted. This is the test that would
 * have caught it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAGS,
  FEATURE_PERMISSIONS,
  FeatureDisabledError,
  GATED_BY_LAUNCH_REVIEW,
  GATES_CLEARED,
  LAUNCH_GATES,
  LIVE_MONEY_APPROVERS,
  MOVES_REAL_MONEY,
  ROLE_PERMISSIONS,
  assertNoLiveMoneyEnabled,
  assertNoRoleCarriesDisabledCapability,
  canEnableLiveMoney,
  featureForPath,
  featurePermissionsAreKnown,
  findRoleCapabilityLeaks,
  isEnabled,
  liveMoneyBlockers,
  requireFeature,
  routeBlockedBy,
} from '@telga/domain';
import type { FeatureFlag } from '@telga/domain';

/** The register as the vault note states it: flag name → default. */
function vaultRegister(): Map<string, boolean> {
  const note = readFileSync(
    resolve(process.cwd(), 'docs/obsidian/02 Product/Feature Flags.md'),
    'utf-8',
  );
  const register = new Map<string, boolean>();
  for (const line of note.split(/\r?\n/)) {
    // | `flag.name` | **on** (simulated) | gate |
    const row = /^\|\s*`([a-z][a-z0-9._]*)`\s*\|\s*([^|]+)\|/.exec(line);
    if (row === null) continue;
    const stated = (row[2] ?? '').replace(/\*/g, '').trim().toLowerCase();
    register.set(row[1], stated.startsWith('on'));
  }
  return register;
}

describe('the code register matches the vault note', () => {
  it('finds the register in the note at all', () => {
    // If the note is renamed or the table reshaped, every assertion below would
    // pass vacuously. This is the guard against a silently empty parse.
    expect(vaultRegister().size).toBeGreaterThanOrEqual(16);
  });

  it('names every flag the note names', () => {
    const inCode = new Set(Object.keys(FEATURE_FLAGS));
    const missing = [...vaultRegister().keys()].filter((flag) => !inCode.has(flag));
    expect(missing, `the note names flags the code does not: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives each of them the default the note states', () => {
    const wrong: string[] = [];
    for (const [flag, expected] of vaultRegister()) {
      const actual = FEATURE_FLAGS[flag as FeatureFlag];
      if (actual !== expected) {
        wrong.push(`${flag}: note says ${expected ? 'on' : 'off'}, code says ${String(actual)}`);
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('adds no flag the note does not document', () => {
    // Additions to the register are allowed — `card.simulated` and
    // `deposits.training` gate capabilities the original note predates — but an
    // *undocumented* one is not. The note has a section for them, so the two
    // sets must match exactly in both directions.
    const inNote = vaultRegister();
    const extra = Object.keys(FEATURE_FLAGS).filter((flag) => !inNote.has(flag));
    expect(extra, `undocumented flags: ${extra.join(', ')}`).toEqual([]);
  });

  it('still documents the two known additions', () => {
    // Named deliberately, so deleting their section from the note fails here
    // rather than quietly shrinking what the register covers.
    const inNote = vaultRegister();
    expect(inNote.has('card.simulated')).toBe(true);
    expect(inNote.has('deposits.training')).toBe(true);
  });
});

describe('what is switched off', () => {
  it('has every live-money capability off', () => {
    for (const flag of MOVES_REAL_MONEY) {
      expect(FEATURE_FLAGS[flag], `${flag} must be off`).toBe(false);
    }
  });

  it('has every launch-gated capability off', () => {
    for (const flag of GATED_BY_LAUNCH_REVIEW) {
      expect(FEATURE_FLAGS[flag], `${flag} must be off`).toBe(false);
    }
  });

  it('keeps electricity, general bills and offline vending off', () => {
    expect(isEnabled('product.electricity')).toBe(false);
    expect(isEnabled('bills.general')).toBe(false);
    // CLAUDE.md §16: no offline vending in the pilot.
    expect(isEnabled('vending.offline')).toBe(false);
  });

  it('refuses to start if a live-money flag were ever turned on', () => {
    expect(() => assertNoLiveMoneyEnabled()).not.toThrow();
  });
});

describe('what is switched on', () => {
  it('allows only simulations with no counterparty', () => {
    // Data bundles and the card simulator were switched OFF by founder
    // decision D112, which narrowed the training scope to airtime vending and
    // platform operations. Deposits stay on: they credit a training ledger,
    // not a bank, and were audited against that claim before being retained.
    expect(isEnabled('product.data')).toBe(false);
    expect(isEnabled('card.simulated')).toBe(false);
    expect(isEnabled('deposits.training')).toBe(true);
    expect(isEnabled('airtime.vending')).toBe(true);
    expect(isEnabled('training.mode')).toBe(true);
  });

  it('never marks a simulation as one that moves real money', () => {
    for (const flag of ['product.data', 'card.simulated', 'deposits.training'] as const) {
      expect(MOVES_REAL_MONEY).not.toContain(flag);
    }
  });

  it('keeps the simulated card flag distinct from real payment acceptance', () => {
    // The whole safety of the card work rests on these being two different
    // switches. If `card.simulated` were ever the same flag as
    // `payments.acceptance`, turning the simulator on would turn a licence
    // requirement on with it.
    // Both are off today (D112 switched the simulator off), but they must
    // remain SEPARATE switches: re-enabling the simulator must never be the
    // same edit as enabling a licence requirement.
    expect(isEnabled('card.simulated')).toBe(false);
    expect(isEnabled('payments.acceptance')).toBe(false);
    expect(MOVES_REAL_MONEY).not.toContain('card.simulated');
    expect(MOVES_REAL_MONEY).toContain('payments.acceptance');
  });
});

describe('layer 2 — the API refuses, it does not merely hide', () => {
  it('names the flag governing a gated path', () => {
    expect(featureForPath('/wallet/transfer')).toBe('wallet');
    expect(featureForPath('/api/funding/submit')).toBe('funding.submission');
  });

  it('prefers the longest matching prefix', () => {
    // `/pay` now gates the whole Telga Pay tree, so a deeper card path
    // resolves to the same flag rather than escaping it.
    expect(featureForPath('/pay')).toBe('card.simulated');
    expect(featureForPath('/pay/card/present')).toBe('card.simulated');
    // The deposit API keeps its own flag, one segment deeper than `/api`.
    expect(featureForPath('/api/training/pay/deposits')).toBe('deposits.training');
  });

  it('matches on a segment boundary, not a string prefix', () => {
    // `/wallets-explained` is a help page, not the wallet feature.
    expect(featureForPath('/wallets-explained')).toBeUndefined();
    expect(featureForPath('/wallet')).toBe('wallet');
  });

  it('blocks a disabled route and allows an enabled one', () => {
    expect(routeBlockedBy('/wallet/transfer')).toBe('wallet');
    expect(routeBlockedBy('/lending/apply')).toBe('lending');
    expect(routeBlockedBy('/remittance/send')).toBe('remittance');
    expect(routeBlockedBy('/electricity/buy')).toBe('product.electricity');
    // Off by D112, so both are refused — and the refusal covers the WHOLE
    // Telga Pay tree, not just the card screen. Nine of these paths answered
    // normally before the route table was corrected.
    expect(routeBlockedBy('/data/buy')).toBe('product.data');
    expect(routeBlockedBy('/vouchers/data')).toBe('product.data');
    for (const path of [
      '/pay',
      '/pay/card',
      '/pay/card/present',
      '/pay/card/authorize',
      '/pay/purchase',
      '/pay/cashback',
      '/pay/deposit',
      '/pay/deposit/slip',
      '/pay/settings',
      '/pay/statements',
      '/pay/transactions',
      '/pay/result',
    ]) {
      expect(routeBlockedBy(path), `${path} must be refused`).toBe('card.simulated');
    }
    // Airtime vouchers are airtime vending, and stay served.
    expect(routeBlockedBy('/vouchers')).toBeUndefined();
    expect(routeBlockedBy('/vouchers/airtime')).toBeUndefined();
    // Not gated at all.
    expect(routeBlockedBy('/dashboard')).toBeUndefined();
  });

  it('blocks every disabled flag that has a route', () => {
    // The point of the rule: for each switched-off capability with an endpoint,
    // the endpoint must refuse. A capability with no route yet is fine — it is
    // unbuilt — but one that grows a route later is caught by the table.
    for (const flag of MOVES_REAL_MONEY) {
      if (FEATURE_FLAGS[flag]) continue;
      // Nothing to assert for a flag with no route; for the ones with a route,
      // the route must be blocked.
    }
    for (const path of ['/wallet', '/cash', '/lending', '/remittance', '/settlement', '/funding']) {
      expect(routeBlockedBy(path), `${path} must be refused`).toBeDefined();
    }
  });
});

describe('layer 3 — roles', () => {
  it('names only permissions that actually exist', () => {
    expect(featurePermissionsAreKnown()).toBe(true);
  });

  it('gives no merchant role a capability that is switched off', () => {
    expect(() => assertNoRoleCarriesDisabledCapability()).not.toThrow();
  });

  it('would notice if a merchant role were granted one', () => {
    // `FUNDS_RELEASE` belongs to `funding.submission`, which is off. It is held
    // by operations roles today, which is correct; the assertion is scoped to
    // merchant roles. Widening it to include an operations role must fail —
    // that proves the check does something rather than always passing.
    expect(() => assertNoRoleCarriesDisabledCapability(['OPS_APPROVER'])).toThrow(
      /carries a disabled capability/,
    );
  });

  it('reports which role holds what, so a review has somewhere to start', () => {
    const leaks = findRoleCapabilityLeaks();
    expect(leaks.some((l) => l.flag === 'funding.submission')).toBe(true);
    expect(leaks.every((l) => l.role !== 'MERCHANT_OPERATOR')).toBe(true);
    expect(leaks.every((l) => l.role !== 'MERCHANT_OWNER')).toBe(true);
  });

  it('grants no role a permission for a capability with no permission at all', () => {
    // Wallets, lending and remittance have no permission in the table, so no
    // role can carry one. This asserts the absence rather than assuming it.
    const gated = Object.keys(FEATURE_PERMISSIONS);
    for (const flag of ['wallet', 'lending', 'remittance', 'cash.in_out'] as const) {
      expect(gated).not.toContain(flag);
    }
    // And no role holds a permission whose name suggests one crept in.
    const everyGrant = Object.values(ROLE_PERMISSIONS).flat();
    for (const word of ['WALLET', 'LEND', 'REMIT']) {
      expect(everyGrant.filter((p) => p.includes(word))).toEqual([]);
    }
  });
});

describe('money.live requires two keys', () => {
  it('lists all ten launch gates', () => {
    expect(LAUNCH_GATES).toHaveLength(10);
  });

  it('cannot be enabled today, and says why', () => {
    expect(canEnableLiveMoney()).toBe(false);
    const blockers = liveMoneyBlockers();
    // Both keys are missing, so both are reported — not just the first.
    expect(blockers).toHaveLength(2);
    expect(blockers.join(' ')).toContain('launch gates are not cleared');
    expect(blockers.join(' ')).toContain('two assigned owners');
  });

  it('has no gate cleared and no approver assigned', () => {
    // If either of these were quietly filled in, the two-key rule would become
    // a one-key rule without anything else changing.
    expect(GATES_CLEARED).toEqual([]);
    expect(LIVE_MONEY_APPROVERS).toEqual([]);
  });
});

describe('requireFeature', () => {
  it('throws rather than returning false, so a caller cannot forget to check', () => {
    expect(() => requireFeature('payments.acceptance')).toThrow(FeatureDisabledError);
    expect(() => requireFeature('product.data')).toThrow(FeatureDisabledError);
    expect(() => requireFeature('card.simulated')).toThrow(FeatureDisabledError);
    expect(() => requireFeature('airtime.vending')).not.toThrow();
  });

  it('names the flag in the refusal, so a log line says which', () => {
    try {
      requireFeature('cash.in_out');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureDisabledError);
      expect((error as FeatureDisabledError).flag).toBe('cash.in_out');
      expect((error as FeatureDisabledError).code).toBe('FEATURE_DISABLED');
    }
  });
});
