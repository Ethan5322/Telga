/**
 * Feature flags and capability checks.
 *
 * The register below is the one written down in `02 Product/Feature Flags`,
 * transcribed name for name. That note is the specification; this file is the
 * implementation of it, and `tests/domain/feature-flags.test.ts` asserts the
 * two agree. An earlier version of this module invented its own names, which
 * meant the note and the code could drift apart without anything failing.
 *
 * ## The rule, quoted
 *
 * > A disabled feature must be inaccessible in **UI, APIs, roles, and
 * > deployment** — not merely hidden. Hiding a button while the endpoint still
 * > answers is a defect.
 *
 * Four layers, of which this file provides three and names the fourth:
 *
 * | Layer | Where it lives |
 * |---|---|
 * | UI | The screen and its entry points do not render — callers use {@link isEnabled} |
 * | API | The route answers `404` with `FEATURE_DISABLED` — {@link routeBlockedBy} |
 * | Roles | No role carries the capability — {@link assertNoRoleCarriesDisabledCapability} |
 * | Deployment | The module is not built into the artifact — **not implemented**, see below |
 *
 * The deployment layer is the one still missing. Every disabled capability is
 * currently *unbuilt* rather than *excluded*, which achieves the same result by
 * accident: there is no wallet module to leave out. The layer becomes real work
 * the day one of these is written, and until then claiming it would be false.
 * {@link assertNoLiveMoneyEnabled} is the nearest honest substitute — a
 * start-up refusal rather than a build-time exclusion.
 *
 * ## Why the defaults are not configurable
 *
 * There is no setting, no environment variable and no request that turns one
 * on. Turning one on is a **code change plus a Decision Log entry**, which is
 * the point: a flag whose default can be flipped by configuration is a flag
 * that gets flipped by accident on the day somebody is in a hurry.
 */

import { PERMISSIONS, ROLE_PERMISSIONS } from './auth';
import type { ActorRole, Permission } from './auth';

/**
 * Every capability that can be gated.
 *
 * The first fourteen are the vault register, in its order and under its names.
 * The two after them are additions: capabilities that exist in this build and
 * needed a switch, recorded here rather than left ungated.
 */
export type FeatureFlag =
  // --- the register in `02 Product/Feature Flags` ---------------------------
  /** Selling airtime. On, against a simulator; live traffic needs a provider agreement. */
  | 'airtime.vending'
  /** The master switch for real money. Two keys — see {@link liveMoneyBlockers}. */
  | 'money.live'
  /** Simulated funds, and the banner that says so. Off only when `money.live` is on. */
  | 'training.mode'
  /** Electricity tokens. Needs separate provider authorization. */
  | 'product.electricity'
  /** Data bundles. On, training-only — Decision Log D72. */
  | 'product.data'
  /** Holding customer funds. Telga is not a wallet or a custodian. */
  | 'wallet'
  /** Accepting a customer's payment instrument for real. Needs an acquirer and a licence. */
  | 'payments.acceptance'
  /** Taking money in or paying it out over a counter. */
  | 'cash.in_out'
  /** Credit in any form. */
  | 'lending'
  /** Money transfer, domestic or cross-border. */
  | 'remittance'
  /** General bill payment. Needs separate provider authorization. */
  | 'bills.general'
  /** Selling with no connection to Telga. Refused for the pilot. */
  | 'vending.offline'
  /** Settling with providers directly rather than through a partner. */
  | 'settlement.independent'
  /** Crediting a merchant float from a real deposit. */
  | 'funding.submission'

  // --- additions beyond the register ----------------------------------------
  /**
   * Simulated card reads and authorisations — Decision Log D87.
   *
   * Distinct from `payments.acceptance`: nothing behind this reaches a card
   * network, a processor or a bank. It gates the simulator, not the money.
   */
  | 'card.simulated'
  /**
   * Simulated deposits into a training float — Decision Log D70.
   *
   * Distinct from `funding.submission`, which is a real deposit against a real
   * bank reference. This one credits a training ledger and nothing else.
   */
  | 'deposits.training'
  /**
   * A shop registering itself from the Telga app — Decision Log **D138**.
   *
   * Gates the *Register as vendor* route and nothing else. It does **not**
   * approve anything, create an account, or make a device trustworthy: what it
   * turns on is the ability to put an unverified application into a queue a
   * human then reads. Approval stays where it was, in the console, behind
   * `ADMIN_REVIEW_APPLICATION`.
   *
   * It is its own flag rather than part of `airtime.vending` because it is the
   * **only** surface on this platform that an unauthenticated stranger may
   * write through. If that ever needs closing — a flood, an abuse report, a
   * regulator's question — it must be one switch, not a deployment.
   */
  | 'registration.self_service'
  /**
   * A merchant asking for a sale to be reversed — `CLAUDE.md` §17.1.
   *
   * Gates the *request*, never the settlement. Completing a reversal is a
   * supervisor's act and has its own permission; turning this off stops
   * merchants filing, and changes nothing about who may approve one.
   */
  | 'reversal.merchant_initiated'
  /**
   * Balance moving from one shop to another — §19.1. **Off, and regulated.**
   *
   * Moving value between two legal entities is money transfer. §2 and §7 list
   * `remittance`, `cash.in_out` and `payments.acceptance` as disabled until
   * legal review and an authorized-partner structure exist, and this belongs
   * with them. What is built behind it is a **training simulation** on the same
   * precedent as the Telga Pay card simulator (D87/D124): a training ledger, no
   * counterparty, no bank, no network.
   *
   * Turning it on is a founder decision that needs legal advice first. It is
   * deliberately **not** listed in `MOVES_REAL_MONEY`, because what sits behind
   * it today moves none — and putting it there would make that list mean
   * "features we are nervous about" rather than "features that move real money".
   */
  | 'transfer.shop_to_shop';

/**
 * What is on.
 *
 * Everything regulated is off. What is on is a simulation with no counterparty:
 * it touches a training ledger and nothing else.
 */
export const FEATURE_FLAGS: Readonly<Record<FeatureFlag, boolean>> = Object.freeze({
  'airtime.vending': true,
  'money.live': false,
  'training.mode': true,

  // **Off by founder decision D112**, reversing D72. D72 approved data vouchers
  // as a training-only flow; the founder has since narrowed the training scope
  // to airtime vending and platform operations, and switched this off. The flow
  // and its migration remain in the tree — removing them would be a larger and
  // riskier change than switching them off — but no route serves them and no
  // role can reach them. Re-enabling needs a new decision, not a config edit.
  'product.data': false,

  'product.electricity': false,
  wallet: false,
  'payments.acceptance': false,
  'cash.in_out': false,
  lending: false,
  remittance: false,
  'bills.general': false,
  'vending.offline': false,
  'settlement.independent': false,
  'funding.submission': false,

  // **On by founder decision D124**, reversing D112 and restoring D87's surface.
  //
  // The founder asked for Telga Pay back "just like it was on localhost" — the
  // simulator, not payment acceptance. That distinction is the whole safety of
  // this flag and it is unchanged: nothing behind `card.simulated` reaches a
  // card network, a processor or a bank. `services/provider-adapters/` contains
  // no `fetch`, no HTTP client and no socket; the card screens in
  // `ui/telgaPay.ts` write nothing; every simulated result is marked
  // `simulated: true`; and the Visa and Mastercard wordmarks carry the string
  // "shown as training examples only. No real card network is connected."
  //
  // **`payments.acceptance` stays false and stays a different flag.** Turning
  // the simulator on must never be the same edit as turning a licence
  // requirement on — see the test that pins them apart.
  //
  // What comes back with it: `/pay`, `/pay/purchase`, `/pay/cashback`,
  // `/pay/card`, `/pay/result`, `/pay/settings`, `/pay/statements`,
  // `/pay/transactions`, and — the operationally useful one — `/pay/deposit`,
  // which is the only in-app way to credit a training float and was unreachable
  // while this was off (A100, D113c).
  'card.simulated': true,

  // Stays on, and stays deliberately narrow. `application/deposits.ts` refuses
  // any mode but TRAINING before it reads an amount, credits a balanced
  // append-only posting against `BANK_CLEARING` bounded to 10–50,000 birr,
  // audits it as `TRAINING_DEPOSIT_CREDITED`, and contacts nothing: the module
  // imports no HTTP client and no provider. Its **screen** lived under `/pay`
  // and is therefore unreachable while `card.simulated` is off — see D112.
  'deposits.training': true,

  // **On by founder decision D138**, reversing the registration half of
  // D113(b). The founder specified the flow on 2026-09-09: the app opens on
  // Login and Register as vendor, a shop submits, an admin reviews, and only
  // approval issues credentials.
  //
  // D113(b)'s **device** half is untouched and stays forbidden — a device may
  // not provision itself. Registering a *business* and provisioning a *machine*
  // are different acts with different secrets, and only the first is open here.
  'registration.self_service': true,

  // On. It gates a *request* that a supervisor must still approve, so the
  // worst it can produce is a queue item — see §17.1.
  'reversal.merchant_initiated': true,

  // **On by founder decision D146**, for the training deployment.
  //
  // The founder was shown that moving value between two legal entities is
  // regulated (§2, §7) and instructed that the feature proceed, to be revoked
  // if it causes a problem. Recorded as theirs.
  //
  // **This flag was never what blocks real money.** `money.live` is false and
  // `assertSafeStartup` refuses to boot if any MOVES_REAL_MONEY flag is on, so
  // what this gates is the *simulation* — a training ledger, no counterparty,
  // no bank, no network — exactly as `card.simulated` gates Telga Pay. The
  // regulated question returns in full the day `money.live` is considered, and
  // D146 does not touch that.
  'transfer.shop_to_shop': true,
});

/** Flags that stay off until the CLAUDE.md §8 launch gates are documented. */
export const GATED_BY_LAUNCH_REVIEW: readonly FeatureFlag[] = Object.freeze([
  'money.live',
  'payments.acceptance',
  'wallet',
  'cash.in_out',
  'lending',
  'remittance',
  'settlement.independent',
  'funding.submission',
  'product.electricity',
  'bills.general',
  'vending.offline',
]);

/**
 * True when a flag would let real money move.
 *
 * Kept separate from the register so that adding a regulated capability
 * without adding it here fails a test rather than passing quietly.
 */
export const MOVES_REAL_MONEY: readonly FeatureFlag[] = Object.freeze([
  'money.live',
  'payments.acceptance',
  'wallet',
  'cash.in_out',
  'lending',
  'remittance',
  'settlement.independent',
  'funding.submission',
]);

export class FeatureDisabledError extends Error {
  readonly code = 'FEATURE_DISABLED';
  constructor(readonly flag: FeatureFlag) {
    super(`Refusing "${flag}": the feature is disabled.`);
    this.name = 'FeatureDisabledError';
  }
}

export const isEnabled = (flag: FeatureFlag): boolean => FEATURE_FLAGS[flag];

/**
 * Refuse unless the flag is on.
 *
 * Throws rather than returning false, so a caller cannot forget to check the
 * result — the same reason `commission.ts` throws instead of returning a
 * plausible default.
 */
export function requireFeature(flag: FeatureFlag): void {
  if (!FEATURE_FLAGS[flag]) throw new FeatureDisabledError(flag);
}

// ---------------------------------------------------------------------------
// Layer 2 — the API
// ---------------------------------------------------------------------------

/**
 * Route prefixes that belong to a gated capability.
 *
 * The vault rule is that a disabled feature's endpoint must answer `404`, with
 * "no partial execution, no ledger write". A prefix table is the only way to
 * make that true for a route nobody has written yet: a future
 * `/wallet/transfer` is refused by this table on the day it is added, rather
 * than on the day somebody remembers to add a check inside it.
 *
 * Longest prefix wins, so `/pay/card` can be gated separately from `/pay`.
 */
const FEATURE_ROUTES: readonly (readonly [string, FeatureFlag])[] = Object.freeze([
  ['/sell', 'airtime.vending'],
  ['/data', 'product.data'],
  ['/electricity', 'product.electricity'],
  ['/bills', 'bills.general'],
  ['/wallet', 'wallet'],
  ['/cash', 'cash.in_out'],
  ['/lending', 'lending'],
  ['/remittance', 'remittance'],
  ['/settlement', 'settlement.independent'],
  ['/funding', 'funding.submission'],
  // The **whole** Telga Pay tree, not just the card screen.
  //
  // This entry replaces `['/pay/card', …]`, which was a real hole: it gated
  // `/pay/card` and `/pay/card/present` and left `/pay`, `/pay/purchase`,
  // `/pay/cashback`, `/pay/deposit`, `/pay/deposit/slip`, `/pay/settings`,
  // `/pay/statements`, `/pay/transactions` and `/pay/result` — nine routes —
  // answering normally with the flag off. Switching the flag off would have
  // removed the buttons and left every page reachable by typing its address,
  // which is precisely the "not merely hidden" rule it was meant to satisfy.
  ['/pay', 'card.simulated'],

  // Data vouchers. `/vouchers` and `/vouchers/airtime` stay under
  // `airtime.vending`: selling airtime as a printed voucher is airtime vending,
  // which is in scope. Only the data flow is refused.
  ['/vouchers/data', 'product.data'],

  ['/api/sales', 'airtime.vending'],
  ['/api/funding', 'funding.submission'],
  ['/api/wallet', 'wallet'],

  // The deposit **API**, gated by its own flag rather than by Telga Pay's.
  //
  // The previous entry was `['/deposit', 'deposits.training']`, which matched
  // no route in the system: the screen is `/pay/deposit` and the endpoint is
  // `/api/training/pay/deposits`, so the flag gated nothing at all. Naming the
  // endpoint keeps the API refusable on its own terms — otherwise turning the
  // deposit off would depend on Telga Pay being off, which is a different
  // decision that could later be reversed.
  ['/api/training/pay/deposits', 'deposits.training'],

  // Self-service registration. Gated as a tree so a later `/register/status`
  // is refused by this entry on the day it is written rather than the day
  // somebody remembers to guard it.
  ['/register', 'registration.self_service'],

  // Gated as trees, so a later `/reverse/confirm` or `/transfer/status` is
  // refused by this table on the day it is written rather than the day
  // somebody remembers to guard it.
  ['/reverse', 'reversal.merchant_initiated'],
  ['/transfer', 'transfer.shop_to_shop'],
] as const);

/**
 * The flag governing a path, or `undefined` when the path is not gated.
 *
 * Matches on a segment boundary, so `/wallets-explained` is not treated as
 * `/wallet`.
 */
export function featureForPath(path: string): FeatureFlag | undefined {
  let bestPrefix = '';
  let bestFlag: FeatureFlag | undefined;
  for (const [prefix, flag] of FEATURE_ROUTES) {
    const matches = path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
    if (!matches) continue;
    if (prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestFlag = flag;
    }
  }
  return bestFlag;
}

/**
 * `undefined` when the path may be served, or the flag that refuses it.
 *
 * A caller that gets a flag back must answer `404` and do nothing else — not
 * authenticate, not read a body, not write a row.
 */
export function routeBlockedBy(path: string): FeatureFlag | undefined {
  const flag = featureForPath(path);
  if (flag === undefined) return undefined;
  return FEATURE_FLAGS[flag] ? undefined : flag;
}

// ---------------------------------------------------------------------------
// Layer 3 — roles
// ---------------------------------------------------------------------------

/**
 * The permission a capability would need, for capabilities that have one.
 *
 * Most disabled flags are absent here, and that absence is the point: no
 * permission exists for a wallet, so no role can carry one, so no token can
 * authorize it. {@link findRoleCapabilityLeaks} checks the entries that do
 * exist, and fails the day somebody adds a permission for a capability that is
 * switched off.
 */
export const FEATURE_PERMISSIONS: Readonly<Partial<Record<FeatureFlag, readonly Permission[]>>> =
  Object.freeze({
    'airtime.vending': Object.freeze(['POS_CREATE_SALE'] as const),
    'deposits.training': Object.freeze(['POS_DEPOSIT_TRAINING_FUNDS'] as const),
    'funding.submission': Object.freeze(['FUNDS_RELEASE'] as const),
  });

/** A role that holds a permission belonging to a switched-off capability. */
export interface RoleCapabilityLeak {
  readonly role: ActorRole;
  readonly permission: Permission;
  readonly flag: FeatureFlag;
}

/** Every role/permission pair that a disabled flag should have prevented. */
export function findRoleCapabilityLeaks(): readonly RoleCapabilityLeak[] {
  const leaks: RoleCapabilityLeak[] = [];
  const entries = Object.entries(FEATURE_PERMISSIONS) as [FeatureFlag, readonly Permission[]][];
  for (const [flag, permissions] of entries) {
    if (FEATURE_FLAGS[flag]) continue;
    const roles = Object.entries(ROLE_PERMISSIONS) as [ActorRole, readonly Permission[]][];
    for (const [role, granted] of roles) {
      for (const permission of permissions) {
        if (granted.includes(permission)) leaks.push({ role, permission, flag });
      }
    }
  }
  return leaks;
}

/**
 * The role layer of the rule.
 *
 * `FUNDS_RELEASE` is deliberately mapped to `funding.submission`, which is off,
 * and `OPS_APPROVER` and `ADMIN` hold it — so {@link findRoleCapabilityLeaks}
 * reports those. That is correct and not a defect: releasing held *training*
 * funds is a real operations action today. This assertion therefore checks
 * merchant-facing roles, which must never reach a disabled capability, and
 * leaves the operations roles visible for review rather than hidden.
 */
export function assertNoRoleCarriesDisabledCapability(
  roles: readonly ActorRole[] = ['MERCHANT_OPERATOR', 'MERCHANT_OWNER'],
): void {
  const leaks = findRoleCapabilityLeaks().filter((leak) => roles.includes(leak.role));
  if (leaks.length > 0) {
    const detail = leaks.map((l) => `${l.role} holds ${l.permission} (${l.flag} is off)`).join('; ');
    throw new Error(`Refusing to start: a role carries a disabled capability — ${detail}.`);
  }
}

// ---------------------------------------------------------------------------
// `money.live` requires two keys
// ---------------------------------------------------------------------------

/**
 * The ten gates in CLAUDE.md §8, transcribed.
 *
 * `money.live` needs every one of them documented as cleared **and** dual
 * approval recorded by two assigned owners. Since no owner is assigned, it
 * cannot be enabled today. That is deliberate.
 */
export const LAUNCH_GATES = [
  'COMPANY_AUTHORITY',
  'PROVIDER_AUTHORIZATION',
  'FUNDS_STRUCTURE',
  'MERCHANT_AGREEMENT',
  'PROVIDER_SLA',
  'FUNDING_RECONCILIATION_TESTED',
  'SECURITY_PERMISSIONS_TESTED',
  'SUPPORT_ESCALATION_ASSIGNED',
  'LIMITS_AND_BUDGET_APPROVED',
  'BACKUPS_RECOVERY_TESTED',
] as const;

export type LaunchGate = (typeof LAUNCH_GATES)[number];

/**
 * Gates recorded as cleared. Empty, and every one of them is a document that
 * does not exist rather than a checkbox nobody ticked.
 */
export const GATES_CLEARED: readonly LaunchGate[] = Object.freeze([]);

/**
 * The two owners who must both approve. Empty — `07 Governance/Founders and
 * Roles` assigns nobody, so there is nobody who could approve.
 */
export const LIVE_MONEY_APPROVERS: readonly string[] = Object.freeze([]);

/**
 * Why `money.live` cannot be turned on, in sentences.
 *
 * Returns an empty list only when both keys are present. It is a function
 * rather than a constant so that the answer is computed from the two lists
 * above and cannot be edited to `[]` on its own.
 */
export function liveMoneyBlockers(): readonly string[] {
  const blockers: string[] = [];
  const outstanding = LAUNCH_GATES.filter((gate) => !GATES_CLEARED.includes(gate));
  if (outstanding.length > 0) {
    blockers.push(
      `${outstanding.length} of ${LAUNCH_GATES.length} launch gates are not cleared: ` +
        `${outstanding.join(', ')}.`,
    );
  }
  if (LIVE_MONEY_APPROVERS.length < 2) {
    blockers.push(
      `Dual approval needs two assigned owners; ${LIVE_MONEY_APPROVERS.length} recorded.`,
    );
  }
  return blockers;
}

/** True only when both keys are turned. False today, and provably so. */
export const canEnableLiveMoney = (): boolean => liveMoneyBlockers().length === 0;

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/**
 * The start-up refusal.
 *
 * A build that somehow shipped with a live-money flag on refuses to run rather
 * than starting and hoping the UI hides it. It also checks the two keys, so
 * setting `money.live` to `true` in this file is not enough on its own — the
 * gates and the approvers have to be there too.
 */
export function assertNoLiveMoneyEnabled(): void {
  const on = MOVES_REAL_MONEY.filter((flag) => FEATURE_FLAGS[flag]);
  if (on.length > 0) {
    throw new Error(
      `Refusing to start: live-money features are enabled (${on.join(', ')}). ` +
        'CLAUDE.md §8 requires documented legal review and an authorised-partner ' +
        `structure before any of these may be turned on. Outstanding: ${liveMoneyBlockers().join(' ')}`,
    );
  }
  if (FEATURE_FLAGS['money.live'] && !canEnableLiveMoney()) {
    throw new Error(`Refusing to start: money.live is on but ${liveMoneyBlockers().join(' ')}`);
  }
  // Training mode is what keeps the money simulated. It may only be off when
  // live money is on, never the other way round.
  if (!FEATURE_FLAGS['training.mode'] && !FEATURE_FLAGS['money.live']) {
    throw new Error(
      'Refusing to start: training.mode is off but money.live is not on. ' +
        'That combination is neither simulated nor authorised.',
    );
  }
  assertNoRoleCarriesDisabledCapability();
}

/** Sanity: every permission named in {@link FEATURE_PERMISSIONS} still exists. */
export const featurePermissionsAreKnown = (): boolean =>
  Object.values(FEATURE_PERMISSIONS)
    .flat()
    .every((permission) => (PERMISSIONS as readonly string[]).includes(permission));
