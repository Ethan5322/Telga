/**
 * The POS server.
 *
 * A thin adapter: `node:http` in, the API's `HttpRequest` out, screens rendered
 * from the same view models the client uses. It contains no business rule at
 * all — a route here either serves a screen or forwards to `handle()`.
 *
 * ## Identity comes from the session, on every route
 *
 * There is no merchant id in a URL, a form field or a link. `renderScreen`
 * takes an `AuthContext` produced by `authenticate()`, and every read it
 * performs goes through the API router, which guards itself independently. A
 * screen therefore cannot be rendered for a merchant nobody proved, and a
 * tampered URL has nothing to tamper with.
 *
 * ## Server-rendered, deliberately
 *
 * The counter screens render on the server and post ordinary forms. A POS on a
 * shop counter with an intermittent connection is better served by a page that
 * arrives complete than by one that arrives empty and then fetches. The client
 * script only *enhances*: it polls a transaction that is still in flight. With
 * scripting off, every screen still works and the operator refreshes.
 *
 * ## Training only
 *
 * `page()` throws for any mode but TRAINING, and `assertTrainingBoundary`
 * checks it once at startup, so a misconfigured server fails to boot rather
 * than serving a banner that lies.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  CSRF_COOKIE,
  DEVICE_COOKIE,
  DEVICE_KEY_COOKIE,
  OPERATOR_COOKIE,
  SESSION_COOKIE,
  QUANTITY_LIMITS,
  SUPPORT_CONTACT,
  TRAINING_DEPOSIT_LIMITS,
  authenticate,
  clearCookie,
  csrfMatches,
  handle,
  login,
  logout,
  serializeCookie,
} from '@telga/api';
import type {
  ApiDeps,
  AuthContext,
  AuthFailure,
  HttpRequest,
  SettingsDto,
} from '@telga/api';
import {
  customersScreen,
  endShiftScreen,
  helpScreen,
  learningScreen,
  policyScreen,
  topUpScreen,
} from './ui/menuScreens';
import { POLICY_TEXTS, TRAINING_SUPPORT, learningSteps } from './ui/content';
import { bankDepositAmountScreen, bankDepositSlipScreen } from './ui/bankDepositScreens';
import { shopTransferScreen } from './ui/shopTransferScreens';
import { chapaAmountScreen, chapaSlipScreen } from './ui/chapaScreens';
import { verifyChapaWebhook } from '@telga/provider-chapa';
import { settleChapaDeposit } from '@telga/api';
import { lockScreen } from './ui/lockScreen';
import { offlineScreen, outageScreen } from './ui/serviceStateScreens';
import { cardPresentScreen, cardResultScreen } from './ui/cardScreens';
import {
  SIMULATED_CARDS,
  createSimulatedCardReader,
  createSimulatedProcessor,
} from '@telga/provider-mock-airtime';
import {
  newSubmissionReference,
  parseCookies,
  redeemEnrollmentToken,
  readSettings,
  recipientRejection,
  submissionRejection,
  takeCardPayment,
  unlockWithPin,
} from '@telga/api';
import { ApplicationWriteError, maskRecipient } from '@telga/persistence';
import type { Locale } from '@telga/localization';
import {
  TRAINING_REVERSAL_POLICY,
  TRAINING_TOPUP_POLICY,
  decideReversal,
  formatDepositReference,
} from '@telga/domain';
import { isLocale, t } from '@telga/localization';
import { toTransactionViewModel, succeed, succeedList } from '@telga/pos-view-model';
import type { BalanceDto, RemoteData, TransactionDto, TransactionViewModel } from '@telga/pos-view-model';
import type { CreateOrderDto, ReceiptDto } from '@telga/api';
import type { DeviceId, MerchantUserId } from '@telga/domain';
import {
  TRAINING_CUSTOM_AMOUNT_LIMITS,
  assertNoLiveMoneyEnabled,
  format,
  isEnabled,
  money,
  routeBlockedBy,
} from '@telga/domain';
import { renderToHtml } from './ui/element';
import type { El } from './ui/element';
import type { Chrome } from './ui/chrome';
import { htmlDocument } from './ui/document';
import {
  accessDeniedScreen,
  deviceEnrolmentScreen,
  loginScreen,
  safeErrorScreen,
  sessionExpiredScreen,
} from './ui/authScreens';
import type { AuthChrome } from './ui/authScreens';
import { launcherAppsScreen, launcherScreen } from './ui/launcher';
import {
  amountScreen,
  dataCategoryScreen,
  dataPackageScreen,
  homeScreen,
  mainMenuScreen,
  networkScreen,
  newSaleScreen,
  orderDetailsScreen,
  pinAuthScreen,
  productTypeScreen,
  profitTransferScreen,
  queueScreen,
  transactionDetailScreen,
  statementScreen,
  transactionHistoryScreen,
  voucherFailureScreen,
  settingsScreen,
  slipScreen,
  voucherResultScreen,
  vouchersScreen,
  failureMessage,
  isPinFailure,
  DEFAULT_SLIP_STYLE,
} from './ui/screens';
import type {
  CatalogEntry,
  DataCategory,
  SlipStyle,
  VoucherNetwork,
  VoucherProduct,
} from './ui/screens';
import { DASHBOARD_SERVICES, comingSoonScreen, dashboardScreen } from './ui/dashboard';
import {
  payAmountScreen,
  paySettingsScreen,
  payStatementsScreen,
  payTransactionsScreen,
  payCardScreen,
  payDepositScreen,
  payDepositSlipScreen,
  payEntryScreen,
  payResultScreen,
} from './ui/telgaPay';
import type { PayFlow, PayOutcome } from './ui/telgaPay';
import { LOCAL_HTTP_DEFAULTS, terminatesTlsItself, validateTransport } from './transport/config';
import type { TransportConfig } from './transport/config';
import { loadTlsMaterial } from './transport/tls';
import {
  STATE_CHANGING,
  checkHost,
  checkOrigin,
  cookieSecureFor,
  observeUntrustedForwarding,
  resolveScheme,
} from './transport/proxy';
import type { ConnectionFacts, RequestScheme } from './transport/proxy';
import { registrationSubmittedScreen, vendorRegistrationScreen } from './ui/registrationScreens';
import { deviceActivatedScreen, deviceActivationScreen } from './ui/activationScreens';
import { complaintScreen, complaintSentScreen } from './ui/complaintScreens';
import { reversalScreen, reversalSentScreen } from './ui/reversalScreens';
import { checkRegistrationThrottle, registrationSource } from './registration';
import { newNonce, securityHeaders } from './transport/headers';

/** What `/api/training/deposits/orders/open` returns. */
interface BankDepositOrderDto {
  readonly reference: string;
  readonly amountMinor: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * One sentence per refusal — §20.1.
 *
 * Each reason gets its own message rather than a shared "could not print":
 * "you already have a slip" and "that is more than a single deposit may be"
 * lead a shopkeeper to different next actions, and a generic refusal leads
 * them to press the button again.
 */
/** One sentence per Chapa refusal — §20.2. */
function chapaErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null) return undefined;
  switch (code) {
    case 'DISABLED':
      return t(locale, 'chapa.refused.disabled');
    case 'PROVIDER_UNAVAILABLE':
      // Deliberately says nothing was charged. A shopkeeper who thinks a
      // failed start might have taken money will not try again.
      return t(locale, 'chapa.refused.unavailable');
    case 'SHOP_NOT_ACTIVE':
      return t(locale, 'bank_deposit.refused.shop_not_active');
    case 'AMOUNT_BELOW_MINIMUM':
      return t(locale, 'bank_deposit.refused.amount_below_minimum');
    case 'AMOUNT_ABOVE_MAXIMUM':
      return t(locale, 'bank_deposit.refused.amount_above_maximum');
    case 'ORDER_ALREADY_OPEN':
      return t(locale, 'bank_deposit.refused.order_already_open');
    default:
      return t(locale, 'bank_deposit.refused.amount_invalid');
  }
}

/** One sentence per transfer refusal — §19.1. */
function transferErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null) return undefined;
  switch (code) {
    case 'SENDER_NOT_ACTIVE':
      return t(locale, 'transfer.refused.sender_not_active');
    case 'RECIPIENT_UNKNOWN':
      return t(locale, 'transfer.refused.recipient_unknown');
    case 'RECIPIENT_NOT_ACTIVE':
      return t(locale, 'transfer.refused.recipient_not_active');
    case 'SAME_MERCHANT':
      return t(locale, 'transfer.refused.same_shop');
    case 'INSUFFICIENT_BALANCE':
      return t(locale, 'transfer.refused.insufficient');
    case 'OVER_DAILY_LIMIT':
      return t(locale, 'transfer.refused.over_limit');
    default:
      return t(locale, 'transfer.refused.amount_invalid');
  }
}

function bankDepositErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null) return undefined;
  switch (code) {
    case 'SHOP_NOT_ACTIVE':
      return t(locale, 'bank_deposit.refused.shop_not_active');
    case 'AMOUNT_BELOW_MINIMUM':
      return t(locale, 'bank_deposit.refused.amount_below_minimum');
    case 'AMOUNT_ABOVE_MAXIMUM':
      return t(locale, 'bank_deposit.refused.amount_above_maximum');
    case 'ORDER_ALREADY_OPEN':
      return t(locale, 'bank_deposit.refused.order_already_open');
    case 'DEPOSITS_DISABLED':
      return t(locale, 'bank_deposit.refused.deposits_disabled');
    default:
      return t(locale, 'bank_deposit.refused.amount_invalid');
  }
}

export interface PosServerOptions {
  readonly api: ApiDeps;
  readonly environment: string;
  readonly catalog: readonly CatalogEntry[];
  /**
   * The training voucher catalog and its networks. Separate from `catalog`
   * on purpose — see `apps/merchant-pos/src/cli.ts`. Optional so an existing
   * caller that only knows `catalog` still type-checks; the voucher routes
   * render "not found" screens when it is absent rather than throwing.
   */
  /**
   * Where a shop pays money in — §20.1.
   *
   * **Absent by default, and absent means no slip prints.** Telga's bank and
   * account number are `NOT YET CONFIRMED` (§31), and a slip naming no account
   * sends a shopkeeper to a bank counter with nothing to say. Better a screen
   * that admits it than paper that looks official and is useless.
   */
  readonly depositBank?: {
    readonly bankName: string;
    readonly accountName: string;
    readonly accountNumber: string;
  };
  /**
   * Chapa — §20.2. **Absent means the button does nothing**, which is the safe
   * direction for a payment integration with no key configured.
   *
   * The secret key is read from the environment by `cli.ts` and never appears
   * in this file, in a default, or in a commit (§24).
   */
  readonly chapa?: {
    readonly secretKey: string;
    readonly merchantEmail: string;
    readonly callbackUrl?: string;
    readonly returnUrl?: string;
  };
  readonly voucherCatalog?: readonly VoucherProduct[];
  readonly voucherNetworks?: readonly VoucherNetwork[];
  /** Data bundle categories. Absent means the data flow renders no tiles. */
  readonly dataCategories?: readonly DataCategory[];
  /**
   * Directory holding the mark and the app icons, served under `/assets/`.
   *
   * Supplied by the caller because this package builds to CommonJS, where a
   * module cannot locate itself via `import.meta`. Defaults to the path
   * relative to the repository root.
   */
  readonly assetDir?: string;
  readonly simulatedBehaviours: readonly string[];
  readonly defaultLocale?: Locale;
  /**
   * How the deployment is reached. Defaults to loopback plain HTTP, which is
   * the only default safe enough to have one.
   */
  readonly transport?: TransportConfig;
}

/**
 * When each session last proved its PIN at the lock screen.
 *
 * In memory, and deliberately: it is a *lock*, so losing it on restart means
 * asking for the PIN again — the safe direction to fail in. A cookie would be
 * the obvious alternative and is the wrong one: the lock exists to stop
 * somebody who has picked up an unattended machine *with a live session*, and
 * that is exactly the person who could edit a cookie to say "unlocked".
 *
 * Keyed by session id, so signing out and back in starts locked.
 */
const unlockedAt = new Map<string, number>();

/**
 * Lock the screen now, from the menu.
 *
 * Forgetting the unlock makes the next request meet the lock screen. It does
 * nothing when the setting is off — the screen is only ever locked because
 * the shop asked for it to be.
 */
function lockNow(sessionId: string): void {
  unlockedAt.delete(sessionId);
}

/** Record that this session just proved its PIN. */
function markUnlocked(sessionId: string, at: number): void {
  unlockedAt.set(sessionId, at);
  // The map would otherwise grow for the life of the process. Sessions are
  // short-lived, so anything older than a day is certainly finished.
  if (unlockedAt.size > 512) {
    const cutoff = at - 86_400_000;
    for (const [key, value] of unlockedAt) {
      if (value < cutoff) unlockedAt.delete(key);
    }
  }
}

/**
 * Whether the screen is locked for this session.
 *
 * Off unless the shop turned it on. When on, a session that has never proved
 * its PIN at the lock screen is locked — so opening Telga asks for the PIN,
 * which is the behaviour the setting describes.
 */
async function screenIsLocked(
  options: PosServerOptions,
  context: AuthContext,
): Promise<boolean> {
  const settings = readSettings(options.api, context.merchantId);
  if (!settings.screenLockEnabled) return false;
  const last = unlockedAt.get(context.sessionId);
  if (last === undefined) return true;
  return Date.parse(options.api.now()) - last >= settings.lockSeconds * 1000;
}

/**
 * Verify the operator's PIN for the lock screen.
 *
 * Goes through the same `PIN_AUTH` scope a voucher PIN does, so guessing here
 * is bounded by the existing trailing-window lockout — and, like that one,
 * can never contribute to a *login* lockout.
 */
async function verifyOperatorPin(
  options: PosServerOptions,
  context: AuthContext,
  pin: string,
  correlationId: string,
): Promise<boolean> {
  const result = await unlockWithPin(options.api, context, pin, correlationId);
  return result.kind === 'UNLOCKED';
}

/** Every file `/assets/` will serve. Anything not named here is a 404. */
const SERVED_ASSETS = new Set([
  'telga-logo.png',
  'icon-32.png',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'app-vending.png',
  'app-pay.png',
]);

const transportOf = (options: PosServerOptions): TransportConfig =>
  options.transport ?? LOCAL_HTTP_DEFAULTS;

/**
 * Refuse to start with any live-money capability enabled.
 *
 * The deployment-level half of CLAUDE.md §7: a disabled feature must be
 * inaccessible *in deployment*, not merely absent from the UI. Called before
 * a listener is opened, so a build that somehow shipped with one of those
 * flags on never accepts a request at all.
 */
assertNoLiveMoneyEnabled();

export class NotTrainingModeError extends Error {
  readonly code = 'POS_SERVER_REFUSES_NON_TRAINING_MODE';
  constructor(mode: string) {
    super(`The merchant POS server starts in training mode only; configured mode is "${mode}"`);
    this.name = 'NotTrainingModeError';
  }
}

/** Called once at startup. A misconfigured server must not boot. */
export function assertTrainingBoundary(options: PosServerOptions): void {
  if (options.api.mode !== 'TRAINING') throw new NotTrainingModeError(options.api.mode);
}

function authChrome(options: PosServerOptions, locale: Locale): AuthChrome {
  return {
    locale,
    environment: options.environment,
    mode: options.api.mode,
    serverTime: options.api.now(),
  };
}

function chromeFor(
  options: PosServerOptions,
  context: AuthContext,
  locale: Locale,
  csrfToken: string | undefined,
): Chrome {
  return {
    locale,
    environment: options.environment,
    merchantId: context.merchantId,
    mode: options.api.mode,
    serverTime: options.api.now(),
    operatorName: context.displayName,
    operatorId: context.userId,
    deviceId: context.deviceId,
    csrfToken,
    // Drives the client-side inactivity sign-out on every authenticated
    // screen. The server enforces the same window independently.
    idleTimeoutMs: options.api.authConfig.session.idleTimeoutMs,
    // And the shop's own lock window, which is a different thing: locking
    // keeps the session and asks for a PIN. `screenIsLocked` enforces the same
    // number server-side, so the page cannot extend it by lying.
    lockAfterMs: lockWindowMs(options, context),
  };
}

/**
 * The shop's screen-lock window in milliseconds, or `undefined` when off.
 *
 * Read from the merchant's settings rather than from the session config. Those
 * are two different windows and one was standing in for the other: an operator
 * who set "lock after 45 seconds" got the session's 60-second sign-out instead,
 * and the saved 45 did nothing.
 */
function lockWindowMs(options: PosServerOptions, context: AuthContext): number | undefined {
  const settings = readSettings(options.api, context.merchantId);
  return settings.screenLockEnabled ? settings.lockSeconds * 1000 : undefined;
}

/**
 * A `from`/`to` range from the query string, or `undefined` for "everything".
 *
 * Both bounds are inclusive calendar days. A malformed or partial range is
 * treated as no range rather than as an empty one: an owner who typed one date
 * and pressed Apply should see something, not a blank screen.
 */
function dateRange(query: URLSearchParams): { from: string; to: string } | undefined {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';
  if (!iso.test(from) || !iso.test(to)) return undefined;
  // Reversed bounds are a typo, not an empty range. Swapping is what the
  // operator meant and costs nothing.
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Inclusive on both ends: a timestamp's day compared as a string. */
function withinRange(timestamp: string, range: { from: string; to: string }): boolean {
  const day = timestamp.slice(0, 10);
  return day >= range.from && day <= range.to;
}

function localeOf(options: PosServerOptions, query: URLSearchParams): Locale {
  const requested = query.get('locale');
  if (requested !== null && isLocale(requested)) return requested;
  return options.defaultLocale ?? 'en';
}

const views = (dtos: readonly TransactionDto[], locale: Locale): readonly TransactionViewModel[] =>
  dtos.map((dto) => toTransactionViewModel(dto, locale));

type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reasonCode: string; messageKey: string; status: number; correlationId: string };

/**
 * Read through the API's own router rather than reaching into the driver.
 *
 * The screens therefore see exactly what a browser sees — the guard, the
 * merchant scoping and the redaction gate all included — so a leak or a scope
 * bug cannot exist on the server-rendered path while the fetched path stays
 * clean. The session cookie is passed through, so the router authenticates the
 * read independently of whatever this file already decided.
 */
async function readVia<T>(
  options: PosServerOptions,
  path: string,
  query: Record<string, string>,
  cookieHeader: string | undefined,
): Promise<ReadResult<T>> {
  const request: HttpRequest = {
    method: 'GET',
    path,
    query,
    headers: cookieHeader === undefined ? {} : { cookie: cookieHeader },
  };
  const response = await handle(options.api, request);
  const body = response.body as
    | { ok: true; data: T; meta: { correlationId: string } }
    | {
        ok: false;
        error: { reasonCode: string; messageKey: string; status: number };
        meta: { correlationId: string };
      };
  if (body.ok) return { ok: true, data: body.data };
  return {
    ok: false,
    reasonCode: body.error.reasonCode,
    messageKey: body.error.messageKey,
    status: body.error.status,
    correlationId: body.meta.correlationId,
  };
}

function remoteOf<T>(result: ReadResult<T>, at: string): RemoteData<T> {
  if (result.ok) return succeed(result.data, at);
  return {
    status: 'ERROR',
    failure: {
      reasonCode: result.reasonCode,
      messageKey: result.messageKey,
      status: result.status,
      correlationId: result.correlationId,
      at,
    },
  };
}

function remoteListOf(
  result: ReadResult<readonly TransactionDto[]>,
  locale: Locale,
  at: string,
): RemoteData<readonly TransactionViewModel[]> {
  if (result.ok) return succeedList(views(result.data, locale), at);
  return {
    status: 'ERROR',
    failure: {
      reasonCode: result.reasonCode,
      messageKey: result.messageKey,
      status: result.status,
      correlationId: result.correlationId,
      at,
    },
  };
}

export interface ScreenRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly context: AuthContext;
  /** Passed through to the API router so it authenticates each read itself. */
  readonly cookieHeader?: string;
  readonly csrfToken?: string;
  /**
   * The per-response CSP nonce.
   *
   * Required in practice — a page rendered without one loses its script and its
   * stylesheet under the policy — but defaulted here so a test that only cares
   * about markup does not have to invent one.
   */
  readonly nonce?: string;
}

interface QueueData {
  readonly pending: readonly TransactionDto[];
  readonly underReview: readonly TransactionDto[];
  readonly reversalRequired: readonly TransactionDto[];
}

/**
 * Render one authenticated screen.
 *
 * Exported so a test can drive it without a socket. It takes an `AuthContext`
 * rather than a merchant id, which is the whole point: there is no argument a
 * caller could supply to render somebody else's shop.
 */
export async function renderScreen(
  options: PosServerOptions,
  request: ScreenRequest,
): Promise<{ status: number; html: string } | undefined> {
  const { path, query, context } = request;
  const nonce = request.nonce ?? newNonce();
  const locale = localeOf(options, query);
  const chrome = chromeFor(options, context, locale, request.csrfToken);
  const at = options.api.now();
  const cookie = request.cookieHeader;

  // How this shop prints. Read once per render, through the API router, so
  // the same session and merchant binding applies as to every other read —
  // and so a slip cannot be styled by anything the browser sends.
  const settingsResult = await readVia<SettingsDto>(options, '/api/training/settings', {}, cookie);
  const slipStyle: SlipStyle = settingsResult.ok
    ? {
        size: settingsResult.data.slipSize,
        advert: settingsResult.data.slipAdvert,
        // Carried on the style so every slip type gets it without each call
        // site having to remember. Empty fields do not print.
        business: {
          name: settingsResult.data.businessName,
          address: settingsResult.data.businessAddress,
          phone: settingsResult.data.businessPhone,
          tin: settingsResult.data.businessTin,
          licence: settingsResult.data.businessLicence,
          footer: settingsResult.data.slipFooter,
        },
        printBarcode: settingsResult.data.printBarcode,
        printLookupSlip: settingsResult.data.printLookupSlip,
      }
    : DEFAULT_SLIP_STYLE;

  /**
   * The shop's in-app preferences, for the screens that honour them.
   *
   * Read once per render from the same settings the slip style comes from, so
   * a toggle flipped in Settings takes effect on the very next screen rather
   * than at some later moment nobody can predict.
   */
  const prefs = settingsResult.ok
    ? {
        soundEnabled: settingsResult.data.soundEnabled,
        hideBalance: settingsResult.data.hideBalance,
        lowBalanceAlert: settingsResult.data.lowBalanceAlert,
        statementsAdminOnly: settingsResult.data.statementsAdminOnly,
      }
    : { soundEnabled: true, hideBalance: false, lowBalanceAlert: false, statementsAdminOnly: false };

  if (path === '/' || path === '/home') {
    const [balance, recent, queueResult] = await Promise.all([
      readVia<Parameters<typeof homeScreen>[0]['balance'] extends RemoteData<infer B> ? B : never>(
        options,
        '/api/training/balance',
        {},
        cookie,
      ),
      readVia<readonly TransactionDto[]>(options, '/api/training/transactions', { limit: '5' }, cookie),
      readVia<QueueData>(options, '/api/training/queue', {}, cookie),
    ]);
    const needsAttention = queueResult.ok
      ? queueResult.data.pending.length +
        queueResult.data.underReview.length +
        queueResult.data.reversalRequired.length
      : 0;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          homeScreen({
            chrome,
            balance: remoteOf(balance, at),
            recent: remoteListOf(recent, locale, at),
            needsAttention,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/sell') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          newSaleScreen({
            chrome,
            catalog: options.catalog,
            csrfToken: request.csrfToken ?? '',
            // Generated when the form is built, so a double press is idempotent.
            clientRequestId: options.api.newId('req'),
            simulatedBehaviours: options.simulatedBehaviours,
            validationMessage: query.get('error') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // --- training voucher flow (Stage 1: route foundation, no persistence) ---
  //
  // Nothing below writes a transaction, a ledger entry, or any database row.
  // `/vouchers/review` re-derives the product from the catalog rather than
  // trusting the query string for anything beyond a lookup key.

  const voucherNetworkOf = (id: string): VoucherNetwork | undefined =>
    (options.voucherNetworks ?? []).find((n) => n.id === id);

  // --- Telga launcher, dashboard, and the Telga Pay module -----------------
  //
  // One application, one session: every route below is reached only through
  // the same `authenticate()` gate every other screen already passes through
  // in `route()`. Telga Pay has no backend of its own in this version —
  // `/pay/*` never touches `options.api.driver` for anything but the
  // existing, already-approved read of this merchant's own transactions.

  // Moving profit into the selling balance. The GET renders the form and the
  // POST forwards to the JSON API, so the guard chain's CSRF, permission and
  // rate checks run — there is no second, hand-rolled check here.
  if (path === '/profit/transfer') {
    const balance = await readVia<BalanceDto>(options, '/api/training/balance', {}, cookie);
    const availableMinor = balance.ok ? (balance.data.profitAvailable?.amountMinor ?? 0) : 0;
    const moved = query.get('moved');
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          profitTransferScreen({
            chrome,
            profitAvailableMinor: availableMinor,
            profitAvailableFormatted: format(money(availableMinor)),
            csrfToken: request.csrfToken ?? '',
            errorMessage: profitErrorFor(locale, query.get('error')),
            done:
              moved !== null && Number.isSafeInteger(Number(moved))
                ? {
                    movedFormatted: format(money(Number(moved))),
                    remainingFormatted: format(money(availableMinor)),
                    newBalanceFormatted: balance.ok
                      ? format(money(balance.data.available.amountMinor))
                      : '—',
                  }
                : undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // --- the three-bar menu's screens ---------------------------------------
  //
  // Presentation only: none of these move money, and each re-checks the
  // session through the same guard every other authenticated screen uses.

  // Provider outage and Telga unreachable — CLAUDE.md §16. Reachable as
  // screens so an operator can be shown exactly what a real outage looks
  // like, and so the recovery path is exercised rather than described.
  // Present the card. The amount comes from the query, so the purchase and
  // cashback screens can both lead here without a second form.
  if (path === '/pay/card/present') {
    // Two ways in, one screen.
    //
    // `amount` is minor units, which is what this screen and the authorize
    // handler work in. `amountBirr` is what the Telga Pay keypad sends,
    // because an operator types birr — and it may carry decimals, so it is
    // rounded once, here, rather than being trusted as an integer.
    //
    // Before this, the keypad went to `/pay/card`, a click-through mock, and
    // this screen was unreachable except by typing the URL.
    const birrRaw = query.get('amountBirr');
    const amountMinor =
      birrRaw !== null && birrRaw.trim().length > 0
        ? Math.round(Number(birrRaw) * 100)
        : Number(query.get('amount') ?? '0');
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return undefined;
    const reader = createSimulatedCardReader({});
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          cardPresentScreen({
            chrome,
            amountFormatted: format(money(amountMinor)),
            csrfToken: request.csrfToken ?? '',
            cards: SIMULATED_CARDS,
            readerPresent: await reader.isPresent(),
            cashback: query.get('kind') === 'CASHBACK',
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/outage') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          outageScreen({
            chrome,
            productLabel: t(locale, 'voucher.product.airtime'),
            // Everything that is not the blocked product stays sellable: a
            // shop losing one network must not lose its whole counter.
            stillAvailable: [
              { label: t(locale, 'voucher.product.data'), href: '/vouchers/data' },
              { label: t(locale, 'screen.pay_entry'), href: '/pay' },
            ],
            lastCheckedAt: at,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/offline') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(offlineScreen({ chrome, lastSeenAt: at })),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/help') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(helpScreen({ chrome, support: TRAINING_SUPPORT })),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/learning') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(learningScreen({ chrome, steps: learningSteps(locale) })),
        chrome,
        nonce,
      ),
    };
  }

  // --- Chapa deposits — §20.2 -------------------------------------------------
  //
  // One method of paying in, beside the counter slip. The shop pays Chapa;
  // Chapa tells Telga; Telga credits automatically once it has confirmed the
  // payment with Chapa itself.

  if (path === '/deposit/chapa') {
    // Switched off, or no key configured: the screen says so rather than
    // offering a button that cannot work.
    if (!isEnabled('deposit.chapa') || options.chapa === undefined) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          chapaAmountScreen({
            chrome,
            csrfToken: request.csrfToken ?? '',
            minimumFormatted: format(money(TRAINING_TOPUP_POLICY.minimumMinor)),
            maximumFormatted: format(money(TRAINING_TOPUP_POLICY.maximumMinor)),
            errorMessage: chapaErrorFor(locale, query.get('error')),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/deposit/chapa/slip') {
    if (!isEnabled('deposit.chapa') || options.chapa === undefined) return undefined;
    const open = await readVia<{ order: BankDepositOrderDto | null }>(
      options,
      '/api/training/deposits/orders/open',
      {},
      cookie,
    );
    const order = open.ok ? open.data.order : null;
    const checkoutUrl = query.get('pay');
    // Both are needed: an order without a checkout link is a slip nobody can
    // pay, and a link without an order is a payment nothing will match.
    if (order === null || checkoutUrl === null || checkoutUrl.length === 0) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          chapaSlipScreen({
            chrome,
            order: {
              reference: formatDepositReference(order.reference),
              amountFormatted: format(money(order.amountMinor)),
              issuedAt: order.issuedAt,
              expiresAt: order.expiresAt,
            },
            checkoutUrl,
            supportContact: SUPPORT_CONTACT,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // --- Telga transfer — §19.1 ------------------------------------------------
  //
  // Balance moving sideways between two shops. Not a deposit: nothing enters
  // Telga, so this sits apart from both top-up routes.

  if (path === '/transfer') {
    const balance = await readVia<BalanceDto>(options, '/api/training/balance', {}, cookie);
    const sent = query.get('sent');
    const pending = query.get('pending');
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          shopTransferScreen({
            chrome,
            csrfToken: request.csrfToken ?? '',
            availableFormatted: balance.ok ? balance.data.available.formatted : '—',
            errorMessage: transferErrorFor(locale, query.get('error')),
            ...(sent !== null && Number.isSafeInteger(Number(sent))
              ? {
                  done: {
                    amountFormatted: format(money(Number(sent))),
                    feeFormatted: format(money(Number(query.get('fee') ?? '0'))),
                    recipientDeviceId: query.get('to') ?? '',
                    remainingFormatted: balance.ok ? balance.data.available.formatted : '—',
                  },
                }
              : {}),
            ...(pending !== null && Number.isSafeInteger(Number(pending))
              ? { awaitingApproval: { amountFormatted: format(money(Number(pending))) } }
              : {}),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // --- bank deposit slip — §20.1 --------------------------------------------
  //
  // The **Deposit money** button lands here. Nothing on this path moves money:
  // it creates an order and prints paper, and the credit happens in the console
  // once a bank record is confirmed.

  if (path === '/deposit') {
    const open = await readVia<{ order: BankDepositOrderDto | null }>(
      options,
      '/api/training/deposits/orders/open',
      {},
      cookie,
    );
    const order = open.ok ? open.data.order : null;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          bankDepositAmountScreen({
            chrome,
            csrfToken: request.csrfToken ?? '',
            minimumFormatted: format(money(TRAINING_TOPUP_POLICY.minimumMinor)),
            maximumFormatted: format(money(TRAINING_TOPUP_POLICY.maximumMinor)),
            errorMessage: bankDepositErrorFor(locale, query.get('error')),
            ...(order === null
              ? {}
              : {
                  openOrder: {
                    reference: formatDepositReference(order.reference),
                    amountFormatted: format(money(order.amountMinor)),
                    expiresAt: order.expiresAt,
                  },
                }),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/deposit/slip') {
    const open = await readVia<{ order: BankDepositOrderDto | null }>(
      options,
      '/api/training/deposits/orders/open',
      {},
      cookie,
    );
    const order = open.ok ? open.data.order : null;
    // No slip without an order. A reference that is not stored is a reference
    // nobody can honour.
    if (order === null) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          bankDepositSlipScreen({
            chrome,
            order: {
              // Grouped for a human at a counter; the stored form has no
              // hyphens and everything compares against that.
              reference: formatDepositReference(order.reference),
              amountFormatted: format(money(order.amountMinor)),
              issuedAt: order.issuedAt,
              expiresAt: order.expiresAt,
              merchantId: context.merchantId,
            },
            ...(options.depositBank === undefined ? {} : { bank: options.depositBank }),
            supportContact: SUPPORT_CONTACT,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/topup') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          topUpScreen({ chrome, canDeposit: context.role === 'MERCHANT_OWNER' }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/customers') {
    const customers = options.api.driver
      .listCustomers(context.merchantId)
      .map((row) => ({ id: row.id, displayName: row.display_name, phoneMasked: row.phone_masked }));
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          customersScreen({
            chrome,
            customers,
            csrfToken: request.csrfToken ?? '',
            errorMessage:
              query.get('error') !== null ? t(locale, 'customers.invalid') : undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/shift/end') {
    const open = options.api.driver.findOpenShift(
      context.merchantId,
      context.userId,
    );
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          endShiftScreen({
            chrome,
            openedAt: open?.opened_at,
            csrfToken: request.csrfToken ?? '',
            ended: query.get('ended') !== null,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const policyMatch = /^\/policy\/(about|terms|privacy|cookies)$/.exec(path);
  if (policyMatch !== null) {
    const policy = POLICY_TEXTS[policyMatch[1] as keyof typeof POLICY_TEXTS];
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          policyScreen({
            chrome,
            title: t(locale, policy.titleKey),
            paragraphs: policy.paragraphs,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }


  if (path === '/dashboard') {
    const balance = await readVia<BalanceDto>(options, '/api/training/balance', {}, cookie);
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          dashboardScreen({
            chrome,
            balance: remoteOf(balance, at),
            hideBalance: prefs.hideBalance,
            lowBalanceAlert: prefs.lowBalanceAlert,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // Every `COMING_SOON` tile in `DASHBOARD_SERVICES` resolves here. The list is
  // derived from that array rather than hand-written, so a tile can never be
  // added to the grid without a working destination — the "no dead buttons"
  // rule enforced structurally instead of by memory.
  const comingSoonIds = DASHBOARD_SERVICES.filter((s) => s.status === 'COMING_SOON')
    .map((s) => s.id)
    .join('|');
  const comingSoonMatch = new RegExp(`^/dashboard/(${comingSoonIds})$`).exec(path);
  if (comingSoonMatch !== null) {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(comingSoonScreen({ chrome, service: comingSoonMatch[1] })),
        chrome,
        nonce,
      ),
    };
  }

  // --- the launcher, now behind sign-in --------------------------------
  //
  // Two screens, deliberately. `/launcher` is Telga as one button; opening it
  // *navigates* to `/launcher/apps`, which lists the modules. An earlier
  // version expanded both onto one page behind a `<details>`, which reads as
  // two things beside a logo rather than one product that opens.
  //
  // Both are authenticated: login is the first screen now, and a chooser shown
  // before anyone proves who they are tells a stranger holding the machine what
  // Telga does.
  if (path === '/launcher' || path === '/splash') {
    return {
      status: 200,
      html: htmlDocument(renderToHtml(launcherScreen({ chrome })), chrome, nonce),
    };
  }

  if (path === '/launcher/apps') {
    return {
      status: 200,
      html: htmlDocument(renderToHtml(launcherAppsScreen({ chrome })), chrome, nonce),
    };
  }

  // Telga Pay draws the same shell with its **own** menu. One `module` field
  // is the whole difference: the chrome is otherwise identical, so a Pay
  // screen cannot drift away from a vending one in banner, identity or lock.
  const payChrome: Chrome = { ...chrome, module: 'pay' };

  // --- Telga Pay's records ----------------------------------------------
  //
  // Sourced from the **audit trail**, which is where a training deposit is
  // recorded, rather than from a new table. Card attempts are absent by
  // design: a simulated card moves no value, so nothing is posted for one, and
  // the screens say so rather than showing an unexplained empty list.
  if (path === '/pay/transactions' || path === '/pay/statements') {
    const events = options.api.driver
      .readAuditEvents(context.merchantId)
      .filter((row) => row.event_type === 'TRAINING_DEPOSIT_CREDITED');

    const deposits = events
      .map((row) => {
        const metadata = ((): Record<string, unknown> => {
          try {
            return JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
          } catch {
            // A row whose metadata will not parse is still a real deposit; it
            // just cannot say how much. Better a row with a blank amount than
            // a screen that throws.
            return {};
          }
        })();
        const minor = Number(metadata['amountMinor'] ?? 0);
        return {
          at: row.created_at,
          amountFormatted: Number.isSafeInteger(minor) && minor > 0 ? format(money(minor)) : '—',
          // Narrowed, not coerced. `metadata` is parsed JSON, so a value here
          // could be an object — and `String({})` prints "[object Object]" on
          // a screen an operator reads. Same fault the linter caught in the
          // backup manifest.
          method: typeof metadata['method'] === 'string' ? metadata['method'] : '—',
          // An audit row can carry a null entity; a deposit without a reference
          // is still a deposit, and the row shows a dash rather than vanishing.
          // The posting id, recorded in the audit metadata since 2026-08-30.
          // Rows written before that have none, and show a dash — they are
          // still real deposits, they just cannot be reprinted.
          reference:
            typeof metadata['depositId'] === 'string' ? metadata['depositId'] : '—',
          minor: Number.isSafeInteger(minor) ? minor : 0,
        };
      })
      // Newest first, which is the order a counter reads them in.
      .sort((a, b) => (a.at < b.at ? 1 : -1));

    if (path === '/pay/transactions') {
      return {
        status: 200,
        html: htmlDocument(
          renderToHtml(payTransactionsScreen({ chrome: payChrome, deposits })),
          payChrome,
          nonce,
        ),
      };
    }

    // One row per calendar day. Grouped rather than summed into a single
    // figure: "different days must be different" is the whole point of a
    // statement, and a total with no days in it reconciles against nothing.
    const days = new Map<string, { count: number; minor: number }>();
    for (const d of deposits) {
      const day = d.at.slice(0, 10);
      const seen = days.get(day) ?? { count: 0, minor: 0 };
      days.set(day, { count: seen.count + 1, minor: seen.minor + d.minor });
    }
    const byDay = [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, totals]) => ({
        day,
        count: totals.count,
        totalFormatted: format(money(totals.minor)),
      }));

    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(payStatementsScreen({ chrome: payChrome, deposits, byDay })),
        payChrome,
        nonce,
      ),
    };
  }

  // --- Telga Pay's own settings -----------------------------------------
  //
  // Vending's settings were reachable from inside Pay through a shared menu,
  // so Pay had none of its own and Vending's looked like they belonged to it.
  // This is the screen Pay's own menu entry leads to.
  if (path === '/pay/settings') {
    const shop = readSettings(options.api, context.merchantId);
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          paySettingsScreen({
            chrome: payChrome,
            cards: SIMULATED_CARDS,
            // Read from the register rather than restated, so this screen
            // cannot claim a capability is off while the code has it on.
            flags: [
              { name: 'card.simulated', on: isEnabled('card.simulated'), note: t(locale, 'pay.settings.flag_card_note') },
              { name: 'payments.acceptance', on: isEnabled('payments.acceptance'), note: t(locale, 'pay.settings.flag_accept_note') },
              { name: 'deposits.training', on: isEnabled('deposits.training'), note: t(locale, 'pay.settings.flag_deposit_note') },
              { name: 'cash.in_out', on: isEnabled('cash.in_out'), note: t(locale, 'pay.settings.flag_cash_note') },
            ],
            slipSize: shop.slipSize,
          }),
        ),
        payChrome,
        nonce,
      ),
    };
  }

  if (path === '/pay') {
    // "Today's Telga sales" reuses the existing transactions read — real
    // data, honestly labelled as *Telga* sales, never as Telga Pay income
    // (Telga Pay has recorded nothing, since it has no backend yet).
    const recent = await readVia<readonly TransactionDto[]>(
      options,
      '/api/training/transactions',
      { limit: '200' },
      cookie,
    );
    const todayPrefix = at.slice(0, 10);
    let todaysSalesFormatted: string | undefined;
    let todaysSalesCount: number | undefined;
    if (recent.ok) {
      const todaysSuccessful = recent.data.filter(
        (tx) => tx.state === 'SUCCESSFUL' && tx.createdAt.startsWith(todayPrefix),
      );
      if (todaysSuccessful.length > 0) {
        const sumMinor = todaysSuccessful.reduce((sum, tx) => sum + tx.amount.amountMinor, 0);
        todaysSalesFormatted = `${(sumMinor / 100).toFixed(2)} ETB`;
        todaysSalesCount = todaysSuccessful.length;
      }
    }
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(payEntryScreen({ chrome: payChrome, todaysSalesFormatted, todaysSalesCount })),
        payChrome,
        nonce,
      ),
    };
  }

  if (path === '/pay/purchase' || path === '/pay/cashback') {
    const flow: PayFlow = path === '/pay/purchase' ? 'purchase' : 'cashback';
    return {
      status: 200,
      html: htmlDocument(renderToHtml(payAmountScreen({ chrome: payChrome, flow })), payChrome, nonce),
    };
  }

  if (path === '/pay/card') {
    const flow = query.get('flow') === 'cashback' ? 'cashback' : 'purchase';
    const amount = query.get('amount') ?? '';
    const note = query.get('note') ?? '';
    if (amount.length === 0) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(payCardScreen({ chrome: payChrome, flow: flow, amount, note })),
        payChrome,
        nonce,
      ),
    };
  }

  if (path === '/pay/result') {
    const flow = query.get('flow') === 'cashback' ? 'cashback' : 'purchase';
    const amount = query.get('amount') ?? '';
    const note = query.get('note') ?? '';
    const outcomeParam = query.get('outcome');
    const validOutcomes: readonly PayOutcome[] = ['approved', 'declined', 'read_error', 'cancelled'];
    const outcome = validOutcomes.includes(outcomeParam as PayOutcome)
      ? (outcomeParam as PayOutcome)
      : undefined;
    if (amount.length === 0 || outcome === undefined) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(payResultScreen({ chrome: payChrome, flow: flow, amount, note, outcome })),
        payChrome,
        nonce,
      ),
    };
  }

  // The deposit form, and the slip a completed deposit redirects to. The
  // slip is rendered from query parameters rather than re-read, because a
  // deposit is a posting rather than a transaction and there is no
  // `/deposits/:id` to look up — none of the values below is a secret, and
  // none of them is authoritative: the balance shown is re-read from the API.
  if (path === '/pay/deposit') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          payDepositScreen({
            chrome: payChrome,
            csrfToken: request.csrfToken ?? '',
            clientRequestId: options.api.newId('deposit'),
            limits: TRAINING_DEPOSIT_LIMITS,
            errorMessage: query.get('error') !== null ? t(locale, 'pay.deposit.invalid') : undefined,
          }),
        ),
        payChrome,
        nonce,
      ),
    };
  }

  if (path === '/pay/deposit/slip') {
    const depositId = query.get('deposit') ?? '';
    const amountMinor = Number(query.get('amount') ?? '');
    const method = query.get('method') ?? '';
    if (depositId.length === 0 || !Number.isSafeInteger(amountMinor)) return undefined;
    const balance = await readVia<BalanceDto>(options, '/api/training/balance', {}, cookie);
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          payDepositSlipScreen({
            chrome: payChrome,
            receipt: {
              depositId,
              merchantId: chrome.merchantId,
              amountFormatted: format(money(amountMinor)),
              method,
              issuedAt: at,
              availableAfterFormatted: balance.ok
                ? format(money(balance.data.available.amountMinor))
                : '—',
              supportContact: SUPPORT_CONTACT,
            },
            style: slipStyle,
          }),
        ),
        payChrome,
        nonce,
      ),
    };
  }

  if (path === '/settings') {
    const result = await readVia<SettingsDto>(options, '/api/training/settings', {}, cookie);
    if (!result.ok) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          settingsScreen({
            chrome,
            settings: {
              slipSize: result.data.slipSize,
              slipAdvert: result.data.slipAdvert,
              profitPercent: result.data.profitPercent,
              businessName: result.data.businessName,
              businessAddress: result.data.businessAddress,
              businessPhone: result.data.businessPhone,
              businessTin: result.data.businessTin,
              businessLicence: result.data.businessLicence,
              slipFooter: result.data.slipFooter,
              soundEnabled: result.data.soundEnabled,
              hideBalance: result.data.hideBalance,
              lowBalanceAlert: result.data.lowBalanceAlert,
              statementsAdminOnly: result.data.statementsAdminOnly,
              printBarcode: result.data.printBarcode,
              printLookupSlip: result.data.printLookupSlip,
              screenLockEnabled: result.data.screenLockEnabled,
              lockSeconds: result.data.lockSeconds,
            },
            pinMessage: pinMessageFor(locale, query.get('pin')),
            pinChanged: query.get('pin') === 'changed',
            csrfToken: request.csrfToken ?? '',
            savedMessage: query.get('saved') !== null ? t(locale, 'settings.saved') : undefined,
            errorMessage: settingsErrorFor(locale, query.get('error')),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/menu') {
    const balance = await readVia<BalanceDto>(options, '/api/training/balance', {}, cookie);
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(mainMenuScreen({ chrome, balance: remoteOf(balance, at) })),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/vouchers') {
    return {
      status: 200,
      html: htmlDocument(renderToHtml(vouchersScreen({ chrome })), chrome, nonce),
    };
  }

  if (path === '/vouchers/airtime') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(networkScreen({ chrome, networks: options.voucherNetworks ?? [] })),
        chrome,
        nonce,
      ),
    };
  }

  // Data bundles: network → category → package + phone. A separate branch of
  // the tree from airtime, because a bundle is chosen by what it contains
  // rather than by what it costs. Training-only — see Decision Log D72.
  if (path === '/vouchers/data') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          networkScreen({
            chrome,
            networks: options.voucherNetworks ?? [],
            hrefFor: (id) => `/vouchers/data/${encodeURIComponent(id)}`,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const dataNetworkMatch = /^\/vouchers\/data\/([A-Za-z0-9_]+)$/.exec(path);
  if (dataNetworkMatch !== null) {
    const network = voucherNetworkOf(dataNetworkMatch[1]);
    if (network === undefined) return undefined;
    // Only the categories this network actually has bundles for, so a screen
    // never offers a tile that leads to an empty package list.
    const available = new Set(
      (options.voucherCatalog ?? [])
        .filter((p) => p.network === network.id && p.productType === 'DATA' && p.available)
        .map((p) => p.dataCategory),
    );
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          dataCategoryScreen({
            chrome,
            network,
            categories: (options.dataCategories ?? []).filter((c) => available.has(c.id)),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const dataCategoryMatch = /^\/vouchers\/data\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/.exec(path);
  if (dataCategoryMatch !== null) {
    const network = voucherNetworkOf(dataCategoryMatch[1]);
    const categoryId = dataCategoryMatch[2];
    const category = (options.dataCategories ?? []).find((c) => c.id === categoryId);
    if (network === undefined || category === undefined) return undefined;
    const products = (options.voucherCatalog ?? []).filter(
      (p) => p.network === network.id && p.productType === 'DATA' && p.dataCategory === categoryId,
    );
    if (products.length === 0) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          dataPackageScreen({
            chrome,
            network,
            category,
            products,
            csrfToken: request.csrfToken ?? '',
            clientRequestId: options.api.newId('order'),
            errorMessage: amountErrorFor(locale, query.get('error')),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const networkMatch = /^\/vouchers\/airtime\/([A-Za-z0-9_]+)$/.exec(path);
  if (networkMatch !== null) {
    const network = voucherNetworkOf(networkMatch[1]);
    if (network === undefined) return undefined;
    return {
      status: 200,
      html: htmlDocument(renderToHtml(productTypeScreen({ chrome, network })), chrome, nonce),
    };
  }

  const typeMatch = /^\/vouchers\/airtime\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/.exec(path);
  if (typeMatch !== null) {
    const network = voucherNetworkOf(typeMatch[1]);
    const productType = typeMatch[2];
    if (network === undefined || (productType !== 'AIRTIME' && productType !== 'TOPUP')) {
      return undefined;
    }
    const products = (options.voucherCatalog ?? []).filter(
      (p) => p.network === network.id && p.productType === productType,
    );
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          amountScreen({
            chrome,
            network,
            productType,
            products,
            csrfToken: request.csrfToken ?? '',
            clientRequestId: options.api.newId('order'),
            customLimits: TRAINING_CUSTOM_AMOUNT_LIMITS,
            quantityLimits: QUANTITY_LIMITS,
            errorMessage: amountErrorFor(locale, query.get('error')),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // `/orders/:id`, `/orders/:id/authorize`, `/orders/:id/result` — every one
  // of these reads the order **through the API router** (`readVia`), so the
  // same session/device/merchant binding check `getOrderForContext` performs
  // runs on every read, not only on the write that created the order.
  const orderMatch = /^\/orders\/([A-Za-z0-9_]+)$/.exec(path);
  const orderAuthorizeMatch = /^\/orders\/([A-Za-z0-9_]+)\/authorize$/.exec(path);
  const orderResultMatch = /^\/orders\/([A-Za-z0-9_]+)\/result$/.exec(path);

  if (orderMatch !== null || orderAuthorizeMatch !== null || orderResultMatch !== null) {
    const orderId = (orderMatch ?? orderAuthorizeMatch ?? orderResultMatch)?.[1] as string;
    const found = await readVia<CreateOrderDto>(
      options,
      `/api/training/orders/${encodeURIComponent(orderId)}`,
      {},
      cookie,
    );
    if (!found.ok) return undefined;
    const network = voucherNetworkOf(found.data.network);
    if (network === undefined) return undefined;

    // Every figure below comes from the stored order, not from the catalog.
    // A custom-amount product carries `amountMinor: 0` in the catalog, so a
    // summary built from it would show one number and charge another.
    const order = {
      productType:
        found.data.productType === 'TOPUP'
          ? ('TOPUP' as const)
          : found.data.productType === 'DATA'
            ? ('DATA' as const)
            : ('AIRTIME' as const),
      amountMinor: found.data.amountMinor,
      quantity: found.data.quantity,
      totalMinor: found.data.totalMinor,
      profitMinor: found.data.profitMinor,
      recipientMasked: found.data.recipientMasked,
    };

    if (orderMatch !== null) {
      return {
        status: 200,
        html: htmlDocument(
          renderToHtml(
            orderDetailsScreen({
              chrome,
              network,
              order,
              orderId,
              csrfToken: request.csrfToken ?? '',
            }),
          ),
          chrome,
          nonce,
        ),
      };
    }

    if (orderAuthorizeMatch !== null) {
      return {
        status: 200,
        html: htmlDocument(
          renderToHtml(
            pinAuthScreen({
              chrome,
              network,
              order,
              orderId,
              csrfToken: request.csrfToken ?? '',
              // Only the two PIN codes can reach this screen now; anything
              // else was routed to the failure card. `failureMessage` is the
              // safety net so no code can ever render blank.
              errorMessage:
                query.get('error') === 'PIN_INVALID'
                  ? t(locale, 'voucher.pin.wrong')
                  : query.get('error') === 'PIN_LOCKED'
                    ? t(locale, 'voucher.pin.locked')
                    : query.get('error') !== null
                      ? failureMessage(locale, query.get('error') as string)
                      : undefined,
            }),
          ),
          chrome,
          nonce,
        ),
      };
    }

    // orderResultMatch
    //
    // A business-rule refusal arrives here with `?error=`. It renders the
    // failure card — never the PIN screen, because the PIN was accepted.
    const failureCode = query.get('error');
    if (failureCode !== null && failureCode.length > 0) {
      return {
        status: 200,
        html: htmlDocument(
          renderToHtml(voucherFailureScreen({ chrome, network, order, reasonCode: failureCode })),
          chrome,
          nonce,
        ),
      };
    }

    const transactionId = found.data.transactionId;
    const transactionResult =
      transactionId === null
        ? undefined
        : await readVia<TransactionDto>(
            options,
            `/api/training/transactions/${encodeURIComponent(transactionId)}`,
            {},
            cookie,
          );
    const transaction: RemoteData<TransactionViewModel> =
      transactionResult === undefined
        ? {
            status: 'ERROR',
            failure: {
              reasonCode: 'ORDER_NOT_AUTHORIZED',
              messageKey: 'error.validation.recipient',
              status: 409,
              correlationId: '',
              at,
            },
          }
        : transactionResult.ok
          ? succeed(toTransactionViewModel(transactionResult.data, locale), at)
          : {
              status: 'ERROR',
              failure: {
                reasonCode: transactionResult.reasonCode,
                messageKey: transactionResult.messageKey,
                status: transactionResult.status,
                correlationId: transactionResult.correlationId,
                at,
              },
            };
    // The printable slip for a completed sale, so the result screen shows the
    // same piece of paper history and reprint show rather than a second
    // format of its own. A sale still resolving has no receipt yet; the order
    // summary stands in until it does.
    // Every voucher in the batch, in print order. One id for an ordinary
    // sale; N for a bulk print, each its own transaction with its own code.
    const batchIds =
      found.data.transactionIds.length > 0
        ? found.data.transactionIds
        : transactionId === null
          ? []
          : [transactionId];
    const receiptResults = await Promise.all(
      batchIds.map((id) =>
        readVia<ReceiptDto>(
          options,
          `/api/training/transactions/${encodeURIComponent(id)}/receipt`,
          {},
          cookie,
        ),
      ),
    );
    const receipts = receiptResults
      .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
      .map((result) => result.data);

    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          voucherResultScreen({
            chrome,
            network,
            order,
            transaction,
            receipts,
            soundEnabled: prefs.soundEnabled,
            style: slipStyle,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/transactions') {
    // Owner-only when the shop set it that way. Enforced here rather than by
    // hiding the menu entry: an operator who types the URL gets the same
    // refusal as one who taps a link.
    if (prefs.statementsAdminOnly && context.role !== 'MERCHANT_OWNER') {
      return {
        status: 403,
        html: htmlDocument(
          renderToHtml(
            policyScreen({
              chrome,
              title: t(locale, 'menu.statements'),
              paragraphs: [t(locale, 'statements.admin_only')],
            }),
          ),
          chrome,
          nonce,
        ),
      };
    }
    const list = await readVia<readonly TransactionDto[]>(
      options,
      '/api/training/transactions',
      {},
      cookie,
    );
    // The range narrows what is shown; it can never widen it. The read above
    // is already scoped to this session's merchant, so an edited query string
    // reaches nobody else's transactions.
    const range = dateRange(query);
    const filtered =
      list.ok && range !== undefined
        ? { ...list, data: list.data.filter((dto) => withinRange(dto.createdAt, range)) }
        : list;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          transactionHistoryScreen({
            chrome,
            transactions: remoteListOf(filtered, locale, at),
            range,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // --- the statement: one row per calendar day ---------------------------
  //
  // Grouped rather than summed into a single figure. A statement is
  // reconciled against a day's till, and one aggregate reconciles against
  // nothing — "different days must be different" is the requirement.
  if (path === '/statements') {
    if (prefs.statementsAdminOnly && context.role !== 'MERCHANT_OWNER') {
      return {
        status: 403,
        html: htmlDocument(
          renderToHtml(
            policyScreen({
              chrome,
              title: t(locale, 'statements.title'),
              paragraphs: [t(locale, 'statements.admin_only')],
            }),
          ),
          chrome,
          nonce,
        ),
      };
    }
    const list = await readVia<readonly TransactionDto[]>(
      options,
      '/api/training/transactions',
      {},
      cookie,
    );
    const range = dateRange(query);
    const rows = list.ok
      ? list.data.filter((dto) => range === undefined || withinRange(dto.createdAt, range))
      : [];

    const byDay = new Map<string, { sales: number; gross: number; reversals: number }>();
    for (const dto of rows) {
      const day = dto.createdAt.slice(0, 10);
      const seen = byDay.get(day) ?? { sales: 0, gross: 0, reversals: 0 };
      const reversed = dto.state === 'REVERSED' || dto.state === 'REVERSAL_REQUIRED';
      byDay.set(day, {
        // Only a settled sale counts as one. A pending or failed attempt is
        // not a day's takings, and counting it would make the statement
        // disagree with the till it is reconciled against.
        sales: seen.sales + (dto.state === 'SUCCESSFUL' ? 1 : 0),
        gross: seen.gross + (dto.state === 'SUCCESSFUL' ? dto.amount.amountMinor : 0),
        reversals: seen.reversals + (reversed ? 1 : 0),
      });
    }

    const days = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, totals]) => ({
        day,
        sales: totals.sales,
        grossFormatted: format(money(totals.gross)),
        // Straight from the ledger for that day, never recomputed from a rate:
        // `profitForDay` excludes ADJUSTMENT — collecting profit is not a loss —
        // and still counts REVERSAL, because a reversed sale really is un-earned.
        profitFormatted: format(money(options.api.driver.profitForDay(context.merchantId, day))),
        profitMinor: options.api.driver.profitForDay(context.merchantId, day),
        reversals: totals.reversals,
      }));

    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          statementScreen({
            chrome,
            days,
            range,
            totalSales: days.reduce((n, d) => n + d.sales, 0),
            // Summed from the rows shown, so the footer can never disagree
            // with the column above it.
            totalGrossFormatted: format(
              money([...byDay.values()].reduce((n, v) => n + v.gross, 0)),
            ),
            totalProfitFormatted: format(money(days.reduce((n, d) => n + d.profitMinor, 0))),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  // The slip. A pure read of the original transaction — rendering it creates
  // nothing and records nothing.
  const slipMatch = /^\/transactions\/([^/]+)\/slip$/.exec(path);
  if (slipMatch) {
    const id = decodeURIComponent(slipMatch[1]);
    const result = await readVia<ReceiptDto>(
      options,
      `/api/training/transactions/${encodeURIComponent(id)}/receipt`,
      {},
      cookie,
    );
    if (!result.ok) return undefined;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          slipScreen({
            chrome,
            receipt: result.data,
            style: slipStyle,
            csrfToken: request.csrfToken ?? '',
            failureMessage:
              query.get('error') !== null ? t(locale, 'receipt.print.failed') : undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const detail = /^\/transactions\/([^/]+)$/.exec(path);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    const result = await readVia<TransactionDto>(
      options,
      `/api/training/transactions/${encodeURIComponent(id)}`,
      {},
      cookie,
    );
    const remote: RemoteData<TransactionViewModel> = result.ok
      ? succeed(toTransactionViewModel(result.data, locale), at)
      : {
          status: 'ERROR',
          failure: {
            reasonCode: result.reasonCode,
            messageKey: result.messageKey,
            status: result.status,
            correlationId: result.correlationId,
            at,
          },
        };
    return {
      status: result.ok ? 200 : result.status,
      html: htmlDocument(
        renderToHtml(
          transactionDetailScreen({
            chrome,
            transaction: remote,
            polling: {
              statusCheckIntervalMs: options.api.statusCheckIntervalMs,
              maxPolls: options.api.maxClientPolls,
            },
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/queue') {
    const result = await readVia<QueueData>(options, '/api/training/queue', {}, cookie);
    if (!result.ok) {
      return {
        status: result.status,
        html: htmlDocument(
          renderToHtml(safeErrorScreen(authChrome(options, locale), result.correlationId)),
          chrome,
          nonce,
        ),
      };
    }
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          queueScreen({
            chrome,
            pending: views(result.data.pending, locale),
            underReview: views(result.data.underReview, locale),
            reversalRequired: views(result.data.reversalRequired, locale),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  /**
   * Report a problem with a sale — §17.2.
   *
   * Authenticated: only the shop that made the sale may report it, and the
   * merchant comes from the session rather than the form. A complaint form that
   * took a merchant id would let anybody open a case against any shop.
   */
  /**
   * Ask Telga to reverse a sale — §17.1.
   *
   * Authenticated, and the merchant comes from the session. A reversal route
   * that took a merchant id from the form would let anybody file against any
   * shop.
   */
  if (path === '/reverse') {
    const sent = query.get('sent');
    if (sent !== null && sent.length > 0) {
      return {
        status: 200,
        html: htmlDocument(renderToHtml(reversalSentScreen({ chrome, reference: sent })), chrome, nonce),
      };
    }
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          reversalScreen({
            chrome,
            csrfToken: request.csrfToken ?? '',
            refusal: query.get('error') ?? undefined,
            transactionId: query.get('transaction') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/complaint') {
    const sent = query.get('sent');
    if (sent !== null && sent.length > 0) {
      return {
        status: 200,
        html: htmlDocument(
          renderToHtml(complaintSentScreen({ chrome, reference: sent })),
          chrome,
          nonce,
        ),
      };
    }
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          complaintScreen({
            chrome,
            csrfToken: request.csrfToken ?? '',
            refusal: query.get('error') ?? undefined,
            transactionId: query.get('transaction') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/enrol') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          deviceEnrolmentScreen({
            chrome: authChrome(options, locale),
            merchantId: context.merchantId,
            csrfToken: request.csrfToken ?? '',
            refusal: query.get('error') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  return undefined;
}

// --- node:http adapter -----------------------------------------------------

/**
 * Read a body, refusing anything over the configured size.
 *
 * The limit is enforced **while reading**, not after: a caller that streams
 * megabytes must be cut off, not buffered and then rejected.
 */
async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer | 'TOO_LARGE'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) return 'TOO_LARGE';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The parsed body, or a refusal.
 *
 * A discriminated result rather than `unknown | 'TOO_LARGE'`: `unknown`
 * absorbs the string literal, so that union was simply `unknown` and the
 * caller's `body === 'TOO_LARGE'` check was never verified by the compiler. A
 * body that happened to *be* the string `"TOO_LARGE"` would also have been
 * read as a refusal.
 */
type JsonBody = { readonly kind: 'OK'; readonly value: unknown } | { readonly kind: 'TOO_LARGE' };

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<JsonBody> {
  const raw = await readBody(request, limitBytes);
  if (raw === 'TOO_LARGE') return { kind: 'TOO_LARGE' };
  // An empty body and an unparseable one are both "no value", not a refusal:
  // the handler decides whether it needed one.
  if (raw.length === 0) return { kind: 'OK', value: undefined };
  try {
    return { kind: 'OK', value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { kind: 'OK', value: undefined };
  }
}

async function readFormBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, string> | 'TOO_LARGE'> {
  const raw = await readBody(request, limitBytes);
  if (raw === 'TOO_LARGE') return 'TOO_LARGE';
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());
}

export function createPosServer(options: PosServerOptions): Server {
  assertTrainingBoundary(options);
  const transport = transportOf(options);
  validateTransport(transport);

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void route(options, request, response).catch(() => {
      // Never a stack trace and never a message. A correlation id would be
      // better, but by here we may not have one — a safe code is the floor.
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { reasonCode: 'POS_UNEXPECTED_ERROR' } }));
    });
  };

  if (terminatesTlsItself(transport)) {
    // Validated above, so both paths are present; `loadTlsMaterial` throws a
    // typed error the CLI turns into exit 4 if either is unreadable or if they
    // do not belong together.
    const material = loadTlsMaterial(
      transport.tlsCertificatePath as string,
      transport.tlsPrivateKeyPath as string,
    );
    return createTlsServer({ cert: material.cert, key: material.key }, handler);
  }

  return createServer(handler);
}

/**
 * Everything about one connection that the transport rules need.
 *
 * Built once per request so the scheme is decided once, from the socket and the
 * trusted-proxy configuration, rather than re-derived at each place that needs
 * to know.
 */
function factsOf(request: IncomingMessage): ConnectionFacts {
  return {
    remoteAddress: request.socket.remoteAddress,
    // `encrypted` is present only on a TLS socket, so this is true exactly when
    // *this process* terminated TLS for this connection.
    encryptedSocket: (request.socket as { encrypted?: boolean }).encrypted === true,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v[0] : v,
      ]),
    ),
  };
}

/**
 * Headers for an HTML response.
 *
 * Every POS page is session-sensitive: a shared counter machine whose back
 * button re-renders the previous operator's balance from cache is a real leak.
 */
function htmlHeaders(
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    ...securityHeaders({ config: transport, scheme, nonce, sessionSensitive: true }),
  };
}

/**
 * Where to send the operator after signing in.
 *
 * Only a same-origin path is accepted — one leading slash, no second one and no
 * scheme — so `returnTo` cannot be turned into an open redirect to another
 * site dressed up as a Telga login.
 */
/**
 * The default post-login destination is `/launcher`, not `/` — the launcher
 * is the true entry point now. Still only ever a same-origin path: one
 * leading slash, no second one, no scheme.
 */
/**
 * Turn an amount-screen refusal code into a sentence.
 *
 * `INSUFFICIENT_AVAILABLE_BALANCE:<minor>` carries the figure the server
 * actually saw, so the operator is told what they have rather than only that
 * it was not enough. Anything unrecognised falls back to the generic
 * validation message — never a blank area and never a raw code.
 */
/**
 * A refusal from the profit-transfer API, as a sentence.
 *
 * `EXCEEDS_PROFIT` arrives with the actual figure appended (`EXCEEDS_PROFIT:400`)
 * so the screen could show it; the sentence already says "more than the
 * profit you have" and the figure is on the screen above, so the code is
 * matched by prefix and the suffix ignored.
 */
/**
 * The outcome of a PIN change, as a sentence.
 *
 * `mismatch` never reaches the API — the two new-PIN boxes are compared here,
 * because sending a PIN to the server only to be told it was typed twice
 * differently would put it on the wire for no reason.
 */
function pinMessageFor(locale: Locale, code: string | null): string | undefined {
  switch (code) {
    case null:
      return undefined;
    case 'changed':
      return t(locale, 'settings.pin.changed');
    case 'mismatch':
      return t(locale, 'settings.pin.mismatch');
    case 'CURRENT_PIN_WRONG':
      return t(locale, 'settings.pin.wrong_current');
    default:
      // Every `NEW_PIN_*` reason and anything unmapped: one sentence that
      // says what to do rather than which rule was broken.
      return t(locale, 'settings.pin.weak');
  }
}

function profitErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null) return undefined;
  if (code.startsWith('EXCEEDS_PROFIT')) return t(locale, 'profit.transfer.exceeds');
  if (code.startsWith('AMOUNT_')) return t(locale, 'profit.transfer.amount_invalid');
  return t(locale, 'voucher.error.generic');
}

function amountErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null || code.length === 0) return undefined;
  if (code.startsWith('INSUFFICIENT_AVAILABLE_BALANCE')) {
    const minor = Number(code.split(':')[1] ?? '');
    const available = Number.isSafeInteger(minor) ? format(money(minor)) : '';
    return available.length > 0
      ? `Insufficient simulated balance. Available balance: ${available}.`
      : t(locale, 'voucher.error.insufficient_balance');
  }
  switch (code) {
    case 'AMOUNT_BELOW_MINIMUM':
      return t(locale, 'sale.amount.custom.below_min');
    case 'AMOUNT_ABOVE_MAXIMUM':
      return t(locale, 'sale.amount.custom.above_max');
    case 'AMOUNT_NOT_A_MULTIPLE':
      return t(locale, 'sale.amount.custom.not_multiple');
    case 'AMOUNT_NOT_A_NUMBER':
      return t(locale, 'sale.amount.custom.not_a_number');
    case 'RECIPIENT_INVALID':
      return t(locale, 'topup.phone.invalid');
    default:
      return t(locale, 'voucher.amount.invalid');
  }
}

/**
 * Turn a settings refusal into a sentence.
 *
 * Same discipline as `amountErrorFor`: an unrecognised code still produces a
 * sentence rather than a blank strip where an explanation should be.
 */
function settingsErrorFor(locale: Locale, code: string | null): string | undefined {
  if (code === null || code.length === 0) return undefined;
  switch (code) {
    case 'PROFIT_INVALID':
      return t(locale, 'settings.profit.invalid');
    case 'ADVERT_INVALID':
      return t(locale, 'settings.advert.hint');
    case 'FORBIDDEN':
    case 'PERMISSION_DENIED':
      return t(locale, 'settings.permission_denied');
    default:
      return t(locale, 'settings.slip_size.label');
  }
}

/**
 * Where to go after signing in.
 *
 * Defaults to the vending dashboard, **not** the launcher. The launcher is
 * the screen you pass through *before* signing in, to choose an app; landing
 * back on it afterwards made an operator choose twice and was the reported
 * "sign-in first, then pick an app" flow.
 *
 * Anything not a plain same-origin path falls back to the default, so a
 * crafted `returnTo` cannot bounce an operator off-site after a successful
 * sign-in.
 */
export function safeReturnTo(value: string | undefined | null): string {
  // The launcher, not the dashboard: signing in opens Telga, and Telga is
  // what the operator then chooses a module from.
  if (typeof value !== 'string' || value.length === 0) return '/launcher';
  if (!value.startsWith('/')) return '/launcher';
  if (value.startsWith('//')) return '/launcher';
  if (value.includes(':')) return '/launcher';
  // The launcher used to be a pre-sign-in screen, and returning to it after
  // signing in was a loop. It is now the **destination**: login is the first
  // screen and the launcher is what opens after it, so both are allowed
  // through. `/splash` no longer exists and is normalised to the launcher
  // rather than silently sending an old bookmark to the dashboard.
  if (value === '/splash') return '/launcher';
  return value;
}

async function route(
  options: PosServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const transport = transportOf(options);
  const facts = factsOf(request);
  const scheme = resolveScheme(transport, facts);
  // Names an untrusted forwarding hop once, so a missing --trust-proxy entry
  // is a line on stderr rather than a sign-in that silently fails.
  observeUntrustedForwarding(scheme, facts, (line) => {
    process.stderr.write(`${line}\n`);
  });
  const nonce = newNonce();

  const url = new URL(request.url ?? '/', `${scheme.scheme}://pos.local`);
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const cookieHeader = request.headers['cookie'];
  const cookies = parseCookies(cookieHeader);
  const locale = localeOf(options, url.searchParams);
  const limit = options.api.authConfig.session.maxRequestBytes;

  // Cookies follow the **client's** scheme, not this process's listener: behind
  // a terminator the process speaks HTTP while the client used HTTPS.
  const cookieOpts = { secure: cookieSecureFor(transport, scheme) };

  // --- host and origin, before anything else ------------------------------
  //
  // The `Host` header is client-controlled, and a server that reflects it into
  // a redirect or a link will point an operator at somebody else's machine.
  const hostProblem = checkHost(transport, facts);
  if (hostProblem !== undefined) {
    respondHtml(
      response,
      400,
      htmlDocumentAuth(options, safeErrorScreen(authChrome(options, locale), hostProblem), locale, nonce),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (STATE_CHANGING.has(method)) {
    const originProblem = checkOrigin(transport, facts, scheme);
    if (originProblem !== undefined) {
      respondHtml(
        response,
        403,
        htmlDocumentAuth(
          options,
          accessDeniedScreen(authChrome(options, locale), originProblem, options.api.newId('corr')),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }
  }

  // --- disabled features, before anything reads a body or a session --------
  //
  // `02 Product/Feature Flags`: *"A disabled feature must be inaccessible in
  // UI, APIs, roles, and deployment — not merely hidden. Hiding a button while
  // the endpoint still answers is a defect."* The note requires the route to
  // answer `404` with **no partial execution and no ledger write**, so this
  // sits above the API router and above authentication: a refused path never
  // reaches a handler, never parses a body, and never opens a transaction.
  //
  // It is a `404` rather than a `403` on purpose. A `403` confirms the feature
  // exists and is switched off for you; a capability Telga is not licensed to
  // offer should look like a path that was never there.
  const blockedBy = routeBlockedBy(path);
  if (blockedBy !== undefined) {
    if (path.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { reasonCode: 'FEATURE_DISABLED' } }));
    } else {
      // Byte-for-byte the catch-all 404, marker included. A distinct marker
      // here would defeat the point: it would let a caller tell "switched off"
      // apart from "never existed" by reading the page.
      response.writeHead(404, htmlHeaders(transport, scheme, nonce));
      response.end('<p data-testid="not-found">No such screen.</p>');
    }
    return;
  }

  // --- the API, guarded by its own router ---------------------------------
  if (path.startsWith('/api/')) {
    const parsed = method === 'POST' ? await readJsonBody(request, limit) : undefined;
    if (parsed?.kind === 'TOO_LARGE') {
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { reasonCode: 'REQUEST_TOO_LARGE' } }));
      return;
    }
    const apiResponse = await handle(options.api, {
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? (v[0] ?? '') : (v ?? ''),
        ]),
      ),
      body: parsed?.kind === 'OK' ? parsed.value : undefined,
    });
    writeApi(response, apiResponse, transport, scheme);
    return;
  }

  // --- public: sign in ------------------------------------------------------
  // The cover screen. Public by design — it is the front door, shown before
  // any sign-in, and carries nothing that is not already on the login page.
  // The Telga mark, served as the founder's own artwork rather than redrawn.
  //
  // Public and same-origin: the page's CSP is `img-src 'self'`, so this is
  // the only way the real image can reach a screen — a `data:` URI would be
  // refused, and inlining 1.6 MB of base64 into every page would be worse
  // even if it were allowed. Cached hard because the file never changes
  // without a deploy.
  // The name is matched against a fixed list rather than joined onto a
  // directory: a path taken from a URL and concatenated is how a request for
  // `../../etc/passwd` gets served. Nothing outside this list is reachable.
  const assetMatch = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(path);
  if (assetMatch !== null && method === 'GET' && SERVED_ASSETS.has(assetMatch[1])) {
    // Located by the caller rather than from this module's own path: the
    // package builds to CommonJS, where `import.meta` is unavailable, and
    // guessing from `process.cwd()` would break the moment the server is
    // started from anywhere but the repository root.
    const dir = options.assetDir ?? resolve('apps', 'merchant-pos', 'assets');
    const file = resolve(dir, assetMatch[1]);
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
        ...securityHeaders({ config: transport, scheme, sessionSensitive: false }),
      });
      response.end(bytes);
    } catch {
      // A missing asset is a broken build, not a request the caller got
      // wrong — but it must not take the whole page down with it.
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
    return;
  }

  /**
   * The web app manifest — what makes Telga installable.
   *
   * `start_url` is the launcher, so the installed icon opens straight into the
   * two-app chooser rather than wherever the browser happened to be, and
   * `display: standalone` drops the browser chrome. Public, like the icons: it
   * carries no session data and a browser fetches it before anybody signs in.
   */
  if (path === '/manifest.webmanifest' && method === 'GET') {
    const body = JSON.stringify({
      name: 'Telga',
      short_name: 'Telga',
      description: 'Telga merchant vending — training build.',
      start_url: '/launcher',
      scope: '/',
      display: 'standalone',
      background_color: '#122E30',
      theme_color: '#122E30',
      icons: [
        { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/assets/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
    response.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=3600',
      ...securityHeaders({ config: transport, scheme, sessionSensitive: false }),
    });
    response.end(body);
    return;
  }

  // The launcher used to be served here, publicly, before sign-in. It is not
  // any more: **login is the first screen**, and the launcher is an
  // authenticated screen handled by `renderScreen` like every other one.
  //
  // Nothing is routed for it here, so an unauthenticated `/launcher` falls
  // through to the same session check every other screen passes and is sent to
  // sign in — carrying `/launcher` as where it was going.

  if (path === '/login' && method === 'GET') {
    respondHtml(
      response,
      200,
      htmlDocumentAuth(
        options,
        loginScreen({
          chrome: authChrome(options, locale),
          refusal: url.searchParams.get('error') ?? undefined,
          returnTo: safeReturnTo(url.searchParams.get('returnTo')),
          // Remembered from the last sign-in on this machine, so an idle
          // timeout does not make the operator retype the device id. The
          // device key is never remembered and the field stays empty.
          // Remembered from the last sign-in on this machine. After an idle
          // timeout all three are present and the operator supplies a PIN
          // alone; after a restart the operator cookie is gone and they pick
          // themselves again. Sign-out from Settings clears all of them.
          deviceId: cookies[DEVICE_COOKIE],
          deviceSecret: cookies[DEVICE_KEY_COOKIE],
          userId: cookies[OPERATOR_COOKIE],
          // Chosen on the launcher. Only the two known values are accepted —
          // a query parameter is not allowed to put arbitrary text on a
          // sign-in form.
          app: url.searchParams.get('app') === 'pay' ? 'pay' : url.searchParams.get('app') === 'vending' ? 'vending' : undefined,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  /**
   * *Register as Telga member* — the app's second option on open. D138.
   *
   * ## Why this is served here and not by the operations console
   *
   * The console is Telga staff only, bound to loopback or sitting behind a
   * trusted proxy, and no shop can reach it — that is the point of it. The app
   * reaches **this** server, so the applicant-facing half of registration has
   * to live here. The reviewing half stays in the console, where it belongs.
   *
   * ## What it may do
   *
   * Write one row to `merchant_applications` as `SUBMITTED` / `SELF_SERVICE`,
   * and nothing else. No merchant, no operator, no device, no credential, no
   * session. Approval remains a console act behind `ADMIN_REVIEW_APPLICATION`,
   * and issuing credentials remains a separate act after that.
   */
  /**
   * Activate this machine — the code exchange from `CLAUDE.md` §18.2.
   *
   * ## The gap this closes
   *
   * `redeemEnrollmentToken` was written and tested on 2026-09-08 and **had no
   * HTTP caller**. The console could issue a one-hour activation code and there
   * was nowhere on earth to type one, so device keys still came from a CLI run
   * by an administrator — which is the step [[Device Binding]] says the code
   * exchange exists to remove, because it put a long-term credential through
   * handwriting.
   *
   * ## Why it is not `/enrol`
   *
   * `/enrol` mints a key for an operator who is **already signed in**. A device
   * that has never activated has no key, so it cannot sign in, so it can never
   * reach that route. The two look similar and are opposites: one re-keys a
   * known machine, this one admits an unknown one holding a code a human
   * carried.
   *
   * ## Why it is anonymous, and what bounds it
   *
   * It has to be — see above. What bounds it is the same throttle the
   * registration route uses, on its own budget: an activation code is 100 bits
   * from an alphabet that excludes look-alike characters, so guessing it is not
   * the threat; **enumerating device ids** is, and an unknown device and a wrong
   * code already answer identically to prevent that. The throttle is belt and
   * braces on a route that writes a credential.
   */
  if (path === '/activate' && method === 'GET') {
    respondHtml(
      response,
      200,
      htmlDocumentAuth(
        options,
        deviceActivationScreen({
          chrome: authChrome(options, locale),
          refusal: url.searchParams.get('error') ?? undefined,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (path === '/activate' && method === 'POST') {
    const at = options.api.now();
    const source = registrationSource(transport, facts, options.api.recipientSalt);
    const throttlePorts = {
      countRegistrationAttemptsSince: (src: string, since: string): number =>
        options.api.driver.countRegistrationAttemptsSince(`activate:${src}`, since),
      recordRegistrationAttempt: (
        src: string,
        outcome: 'RECORDED' | 'REFUSED',
        when: string,
      ): void => options.api.driver.recordRegistrationAttempt(`activate:${src}`, outcome, when),
      pruneRegistrationAttempts: (before: string): number =>
        options.api.driver.pruneRegistrationAttempts(before),
    };
    // Prefixed, so activation attempts and registration attempts do not spend
    // each other's budget. A shop activating a second till must not be refused
    // because somebody else registered from the same café wi-fi.
    if (!checkRegistrationThrottle(throttlePorts, source, at).allowed) {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      response.writeHead(303, { location: '/activate?error=ACTIVATION_TOO_MANY' });
      response.end();
      return;
    }

    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      response.writeHead(303, { location: '/activate?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }

    const result = await redeemEnrollmentToken(options.api, {
      deviceId: (form['deviceId'] ?? '') as DeviceId,
      token: form['token'] ?? '',
      correlationId: options.api.newId('corr'),
    });

    if (result.kind === 'REFUSED') {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      // Re-rendered with the device id kept, so a mistyped code does not cost
      // the id as well. The code itself is never echoed back.
      respondHtml(
        response,
        403,
        htmlDocumentAuth(
          options,
          deviceActivationScreen({
            chrome: authChrome(options, locale),
            refusal: result.reason,
            deviceId: form['deviceId'],
          }),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }

    throttlePorts.recordRegistrationAttempt(source, 'RECORDED', at);

    // Rendered, never redirected: a device key must not reach a URL, a history
    // entry or a server log. This is the only moment it exists in readable form.
    respondHtml(
      response,
      201,
      htmlDocumentAuth(
        options,
        deviceActivatedScreen({
          chrome: authChrome(options, locale),
          deviceId: result.deviceId,
          deviceSecret: result.deviceSecret,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (path === '/register' && method === 'GET') {
    respondHtml(
      response,
      200,
      htmlDocumentAuth(
        options,
        vendorRegistrationScreen({
          chrome: authChrome(options, locale),
          refusal: url.searchParams.get('error') ?? undefined,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (path === '/register' && method === 'POST') {
    /**
     * The throttle, before the body is read.
     *
     * Deliberately ahead of parsing: a caller who has exhausted the window must
     * not be able to make this process parse a form for them. The bucket is a
     * salted hash of the caller's address — `registration.ts` explains why the
     * address itself is never stored.
     *
     * **The salt is per-process** (`recipientSalt` is a fresh `randomUUID()` at
     * start-up), so a restart empties every bucket. That is a real limit and it
     * fails in the safe direction: a restart forgets who was throttled rather
     * than throttling somebody who was not. A durable salt is a deployment
     * decision, not a code one.
     */
    const at = options.api.now();
    const source = registrationSource(transport, facts, options.api.recipientSalt);
    const throttlePorts = {
      countRegistrationAttemptsSince: (src: string, since: string): number =>
        options.api.driver.countRegistrationAttemptsSince(src, since),
      recordRegistrationAttempt: (
        src: string,
        outcome: 'RECORDED' | 'REFUSED',
        when: string,
      ): void => options.api.driver.recordRegistrationAttempt(src, outcome, when),
      pruneRegistrationAttempts: (before: string): number =>
        options.api.driver.pruneRegistrationAttempts(before),
    };
    const verdict = checkRegistrationThrottle(throttlePorts, source, at);
    if (!verdict.allowed) {
      // Counted as well as refused. A refusal that did not count would let a
      // caller sit at the limit for ever at no cost to themselves.
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      response.writeHead(303, { location: '/register?error=TOO_MANY_ATTEMPTS' });
      response.end();
      return;
    }

    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      response.writeHead(303, { location: '/register?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }

    // The same shape the console builds, checked by the same function. Two
    // hand-written validators is how a rule ends up applying on one path and
    // not on the other.
    const licenceExpiry = form['tradeLicenceExpiry'] ?? '';
    const submission = {
      legalName: form['legalName'] ?? '',
      ownerName: form['ownerName'] ?? '',
      phone: form['phone'] ?? '',
      email: form['email'] ?? '',
      address: form['address'] ?? '',
      locality: form['locality'] ?? '',
      entityType: 'SOLE_TRADER' as const,
      documents: [
        {
          kind: 'TRADE_LICENCE' as const,
          reference: form['tradeLicence'] ?? '',
          // A bare date from a `type="date"` input, widened to a timestamp so a
          // licence expiring today has not expired yet.
          expiresAt: licenceExpiry.length > 0 ? licenceExpiry + 'T23:59:59.999Z' : '',
        },
        { kind: 'TIN_CERTIFICATE' as const, reference: form['tin'] ?? '' },
        { kind: 'OWNER_PHOTO_ID' as const, reference: form['photoId'] ?? '' },
      ],
    };

    const rejection = submissionRejection(submission, at);
    if (rejection !== undefined) {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      // Re-rendered rather than redirected, so the shopkeeper's typing survives
      // one wrong field. A phone form that empties itself is abandoned.
      respondHtml(
        response,
        400,
        htmlDocumentAuth(
          options,
          vendorRegistrationScreen({
            chrome: authChrome(options, locale),
            refusal: rejection,
            values: form,
          }),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }

    const applicationId = options.api.newId('app');
    const reference = newSubmissionReference();
    try {
      options.api.driver.recordApplication({
        id: applicationId,
        reference,
        // The whole reason migration 018 added this column: a reviewer must be
        // able to tell a folder an admin held from a form a stranger typed.
        submittedVia: 'SELF_SERVICE',
        legalName: submission.legalName,
        ownerName: submission.ownerName,
        phone: submission.phone,
        email: submission.email,
        address: submission.address,
        locality: submission.locality,
        at,
        documents: submission.documents.map((document) => ({
          id: options.api.newId('doc'),
          kind: document.kind,
          reference: document.reference,
          ...(document.expiresAt !== undefined && document.expiresAt !== ''
            ? { expiresAt: document.expiresAt }
            : {}),
        })),
      });
    } catch (error) {
      throttlePorts.recordRegistrationAttempt(source, 'REFUSED', at);
      const refusal =
        error instanceof ApplicationWriteError ? error.refusal : 'REGISTRATION_NOT_SAVED';
      respondHtml(
        response,
        409,
        htmlDocumentAuth(
          options,
          vendorRegistrationScreen({
            chrome: authChrome(options, locale),
            refusal,
            values: form,
          }),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }

    throttlePorts.recordRegistrationAttempt(source, 'RECORDED', at);

    // Rendered, not redirected. The reference is the only thing the applicant
    // ever gets back, and a redirect would put it in a URL — browser history on
    // a shared counter phone, and a referrer on the way to anywhere else.
    respondHtml(
      response,
      201,
      htmlDocumentAuth(
        options,
        registrationSubmittedScreen({ chrome: authChrome(options, locale), reference }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (path === '/login' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      respondHtml(
        response,
        413,
        htmlDocumentAuth(options, safeErrorScreen(authChrome(options, locale), 'oversized'), locale, nonce),
        transport,
        scheme,
        nonce,
      );
      return;
    }
    const returnTo = safeReturnTo(form['returnTo']);
    const result = await login(
      options.api,
      {
        userId: (form['userId'] ?? '') as MerchantUserId,
        pin: form['pin'] ?? '',
        deviceId: (form['deviceId'] ?? '') as DeviceId,
        deviceSecret: form['deviceSecret'] ?? '',
      },
      options.api.newId('corr'),
    );
    if (!result.ok) {
      // Post/redirect/get, so a refused attempt is not resubmitted by a refresh
      // and the PIN never survives in the browser's form state.
      response.writeHead(303, {
        location: `/login?error=${encodeURIComponent(result.code)}&returnTo=${encodeURIComponent(returnTo)}`,
      });
      response.end();
      return;
    }
    response.writeHead(303, {
      location: returnTo,
      'set-cookie': [
        serializeCookie(SESSION_COOKIE, result.sessionToken, cookieOpts),
        serializeCookie(CSRF_COOKIE, result.csrfToken, { ...cookieOpts, httpOnly: false }),
        // The device *identifier* only — never the device key. Remembered so
        // a re-login after an idle timeout needs the operator id and PIN,
        // not a retyped device id. See `DEVICE_COOKIE`.
        serializeCookie(DEVICE_COOKIE, form['deviceId'] ?? '', cookieOpts),
        // The device key, `httpOnly`, so an idle timeout costs the operator
        // their PIN and nothing else. A founder-specified relaxation — see
        // `DEVICE_KEY_COOKIE` for what it costs and D74 for why.
        serializeCookie(DEVICE_KEY_COOKIE, form['deviceSecret'] ?? '', cookieOpts),
        // No `maxAge`: this dies when the browser does. That is the whole
        // mechanism behind "idle asks for a PIN, a restart also asks who you
        // are" — no extra branch decides it.
        serializeCookie(OPERATOR_COOKIE, form['userId'] ?? '', {
          ...cookieOpts,
          maxAgeSeconds: undefined,
        }),
      ],
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  // --- everything below requires a session ---------------------------------
  const auth = authenticate(options.api, cookies[SESSION_COOKIE], options.api.newId('corr'));
  if (!auth.ok) {
    respondRefused(options, response, auth, path, locale, method, transport, scheme, nonce);
    return;
  }
  const context = auth.context;
  const csrfToken = cookies[CSRF_COOKIE];

  // --- the screen lock ------------------------------------------------------
  //
  // Held here, after the session is proven and before anything is rendered, so
  // no authenticated screen can be reached around it. Unlocking is a POST that
  // verifies the PIN; everything else is refused with the lock screen while
  // the lock is on.
  // Lock on demand, from the menu. Locks the screen; the session lives, so
  // this is not a sign-out and does not clear the device.
  // Read the card and authorise it. The whole decision is made by
  // `takeCardPayment` against the two ports — this route only turns its
  // result into a screen.
  if (path === '/pay/card/authorize' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE' || !csrfMatches(options.api, context.sessionId, form['csrfToken'])) {
      response.writeHead(303, { location: '/pay' });
      response.end();
      return;
    }
    const amountMinor = Number(form['amountMinor'] ?? '0');
    const entryMode = (['TAP', 'INSERT', 'SWIPE'] as const).find((m) => m === form['entryMode']) ?? 'INSERT';
    const result = await takeCardPayment(
      {
        reader: createSimulatedCardReader({ lastFour: form['lastFour'] ?? '4242', entryMode }),
        processor: createSimulatedProcessor(),
        mode: options.api.mode,
        now: () => options.api.now(),
        newId: (prefix: string) => options.api.newId(prefix),
      },
      {
        amountMinor,
        kind: form['kind'] === 'CASHBACK' ? 'CASHBACK' : 'PURCHASE',
        cashOutMinor: Number(form['cashOutMinor'] ?? '0'),
        entryMode,
        clientRequestId: form['clientRequestId'] ?? options.api.newId('card'),
      },
    );

    const chromeForResult = chromeFor(options, context, locale, cookies[CSRF_COOKIE]);

    // --- the slip, for every outcome ---------------------------------------
    //
    // A declined or unanswered card is exactly the attempt a customer argues
    // about later, so the paper must exist for those too — not only for an
    // approval. The outcome is printed **in words** on the slip, so a decline
    // slip can never be mistaken for a receipt.
    const outcomeWord =
      result.kind === 'APPROVED'
        ? t(locale, 'card.approved')
        : result.kind === 'NO_RESPONSE'
          ? t(locale, 'card.no_response_heading')
          : t(locale, 'card.declined_heading');
    const card = 'card' in result ? result.card : undefined;
    const slipFor = (): Parameters<typeof cardResultScreen>[0]['slip'] => ({
      subtitle: t(locale, 'screen.pay_card'),
      supportContact: SUPPORT_CONTACT,
      style: DEFAULT_SLIP_STYLE,
      // Ordered the way a slip is read at a counter, not the way the data
      // happens to arrive: **the outcome first**, because that is the one line
      // a customer looks for and an operator points at. Money next, then the
      // card, then the references a dispute needs.
      lines: [
        { id: 'card-slip-outcome', label: t(locale, 'transactions.column.status'), value: outcomeWord },
        { id: 'card-slip-amount', label: t(locale, 'transactions.column.amount'), value: format(money(amountMinor)) },
        // Cash handed back is money that left the till and belongs on the
        // paper beside the amount, not buried under the card details.
        ...(result.kind === 'APPROVED' && result.cashOutMinor > 0
          ? [
              {
                id: 'card-slip-cashout',
                label: t(locale, 'pay.cashback.label'),
                value: format(money(result.cashOutMinor)),
              },
            ]
          : []),
        ...(card !== undefined
          ? [
              { id: 'card-slip-pan', label: t(locale, 'card.number'), value: card.maskedPan },
              { id: 'card-slip-scheme', label: t(locale, 'card.scheme'), value: card.scheme },
              { id: 'card-slip-entry', label: t(locale, 'card.entry_mode'), value: card.entryMode },
            ]
          : []),
        ...(result.kind === 'APPROVED'
          ? [{ id: 'card-slip-auth', label: t(locale, 'card.reference'), value: result.authorizationCode }]
          : []),
        { id: 'card-slip-at', label: t(locale, 'transactions.column.datetime'), value: options.api.now() },
      ],
    });

    const screen =
      result.kind === 'APPROVED'
        ? cardResultScreen({
            chrome: chromeForResult,
            outcome: 'APPROVED',
            slip: slipFor(),
            amountFormatted: format(money(result.amountMinor)),
            cashOutFormatted:
              result.cashOutMinor > 0 ? format(money(result.cashOutMinor)) : undefined,
            maskedPan: result.card.maskedPan,
            scheme: result.card.scheme,
            entryMode: result.card.entryMode,
            authorizationCode: result.authorizationCode,
          })
        : result.kind === 'DECLINED'
          ? cardResultScreen({
              chrome: chromeForResult,
              outcome: 'DECLINED',
              slip: slipFor(),
              amountFormatted: format(money(amountMinor)),
              maskedPan: result.card.maskedPan,
              scheme: result.card.scheme,
              entryMode: result.card.entryMode,
              message: t(locale, result.messageKey as Parameters<typeof t>[1]),
              retryable: result.retryable,
            })
          : result.kind === 'NO_RESPONSE'
            ? cardResultScreen({
                chrome: chromeForResult,
                outcome: 'NO_RESPONSE',
                slip: slipFor(),
                amountFormatted: format(money(amountMinor)),
                maskedPan: result.card.maskedPan,
              })
            : cardResultScreen({
                chrome: chromeForResult,
                outcome: 'NOT_READ',
                slip: slipFor(),
                message: t(
                  locale,
                  result.kind === 'CARD_NOT_READ' && result.why === 'NO_READER'
                    ? 'card.no_reader'
                    : 'card.not_read',
                ),
              });

    respondHtml(response, 200, htmlDocument(renderToHtml(screen), chromeForResult, nonce), transport, scheme, nonce);
    return;
  }

  if (path === '/lock' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form !== 'TOO_LARGE' && csrfMatches(options.api, context.sessionId, form['csrfToken'])) {
      lockNow(context.sessionId);
    }
    response.writeHead(303, {
      location: '/lock',
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/unlock' && method === 'POST') {
    const form = await readFormBody(request, limit);
    const supplied = form === 'TOO_LARGE' ? '' : (form['pin'] ?? '');
    const destination = form === 'TOO_LARGE' ? '/dashboard' : safeReturnTo(form['returnTo']);
    const csrfOk =
      form !== 'TOO_LARGE' && csrfMatches(options.api, context.sessionId, form['csrfToken']);

    const unlocked =
      csrfOk &&
      (await verifyOperatorPin(options, context, supplied, options.api.newId('corr')));

    if (unlocked) {
      markUnlocked(context.sessionId, Date.parse(options.api.now()));
      response.writeHead(303, {
        location: destination,
        ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
      });
      response.end();
      return;
    }
    response.writeHead(303, {
      // Only a code in the URL — never the PIN that was typed.
      location: `/lock?error=1&returnTo=${encodeURIComponent(destination)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (await screenIsLocked(options, context)) {
    // Signing out must stay reachable: whoever is holding the machine may not
    // be the operator whose PIN it wants.
    if (!(path === '/logout' && method === 'POST')) {
      respondHtml(
        response,
        200,
        htmlDocumentAuth(
          options,
          lockScreen({
            chrome: authChrome(options, locale),
            operatorId: context.displayName ?? context.userId,
            csrfToken: csrfToken ?? '',
            returnTo: safeReturnTo(path === '/lock' ? url.searchParams.get('returnTo') : path),
            errorMessage:
              url.searchParams.get('error') !== null ? t(locale, 'lock.wrong') : undefined,
          }),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }
  }

  if (path === '/logout' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE' || !csrfMatches(options.api, context.sessionId, form['csrfToken'])) {
      respondHtml(
        response,
        403,
        htmlDocumentAuth(
          options,
          accessDeniedScreen(authChrome(options, locale), 'CSRF_TOKEN_INVALID', options.api.newId('corr')),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }
    logout(options.api, context, options.api.newId('corr'));
    response.writeHead(303, {
      location: '/login',
      // Session and CSRF only. `DEVICE_COOKIE` deliberately survives: signing
      // out is an operator action, not a device un-enrolment. Removing a
      // device is a separate explicit operation (`revokeDevice`).
      // Sign-out from Settings is the **full** sign-out the founder specified:
      // all four of device, device key, operator and PIN. It is the only path
      // that clears the device cookies, which is what makes it the right
      // action when a device changes hands. An idle expiry clears none of
      // them — that path never reaches here.
      'set-cookie': [
        clearCookie(SESSION_COOKIE, cookieOpts),
        clearCookie(CSRF_COOKIE, { ...cookieOpts, httpOnly: false }),
        clearCookie(DEVICE_COOKIE, cookieOpts),
        clearCookie(DEVICE_KEY_COOKIE, cookieOpts),
        clearCookie(OPERATOR_COOKIE, cookieOpts),
      ],
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  // Voucher orders. Every one of these forwards to the JSON API through
  // `handle()`, exactly like `/sell` already does for `/api/training/sales` —
  // so the guard chain's own CSRF check runs, not a second hand-rolled one.

  // Saving a regular. The number is masked here, at the boundary, before it
  // reaches the database — this list is a convenience for recognising a
  // customer, never a store of full numbers.
  if (path === '/customers' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/customers?error=1' });
      response.end();
      return;
    }
    const name = (form['displayName'] ?? '').trim();
    const phone = (form['phone'] ?? '').trim();
    const csrfOk = csrfMatches(options.api, auth.context.sessionId, form['csrfToken']);
    if (!csrfOk || name.length === 0 || recipientRejection(phone) !== undefined) {
      response.writeHead(303, {
        location: '/customers?error=1',
        ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
      });
      response.end();
      return;
    }
    options.api.driver.saveCustomer({
      id: options.api.newId('cust'),
      merchantId: auth.context.merchantId,
      displayName: name,
      phoneMasked: maskRecipient(phone),
      at: options.api.now(),
    });
    response.writeHead(303, {
      location: '/customers',
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/shift/end' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form !== 'TOO_LARGE' && csrfMatches(options.api, auth.context.sessionId, form['csrfToken'])) {
      const open = options.api.driver.findOpenShift(
        auth.context.merchantId,
        auth.context.userId,
      );
      // Closing an already-closed shift is a no-op rather than an error: the
      // operator's intent — "this shift is over" — is already true.
      if (open !== undefined) options.api.driver.closeShift(open.id, options.api.now());
    }
    response.writeHead(303, {
      location: '/shift/end?ended=1',
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/reverse' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/reverse?error=NOT_SAVED' });
      response.end();
      return;
    }

    const transactionId = (form['transactionId'] ?? '').trim();
    const reason = (form['reason'] ?? '').trim();
    if (transactionId.length === 0) {
      response.writeHead(303, { location: '/reverse?error=TRANSACTION_REQUIRED' });
      response.end();
      return;
    }
    if (reason.length === 0) {
      response.writeHead(303, {
        location: `/reverse?error=REASON_REQUIRED&transaction=${encodeURIComponent(transactionId)}`,
      });
      response.end();
      return;
    }

    // Scoped to the session's merchant. A shop may only ask about a sale it
    // made, and the refusal for another shop's transaction is identical to the
    // one for a transaction that does not exist.
    const found = options.api.driver.findTransaction(
      transactionId as never,
      context.merchantId as never,
    );
    if (found === undefined) {
      response.writeHead(303, { location: '/reverse?error=TRANSACTION_NOT_FOUND' });
      response.end();
      return;
    }

    const open = options.api.driver.findOpenReversalRequest(transactionId);

    /**
     * Redemption is `UNKNOWN`, and that is not a placeholder.
     *
     * There is no provider API to ask and no redemption column in the schema,
     * so this build genuinely cannot tell whether a token was used. Passing
     * `UNKNOWN` routes every request to `ACCEPTED_NEEDS_APPROVAL` — a human
     * decides — which is what §17 requires of an unknown outcome. Inventing
     * `UNREDEEMED` here would auto-settle reversals on no evidence at all.
     */
    const decision = decideReversal(
      {
        state: found.state,
        amountMinor: found.amount_minor,
        soldAt: found.created_at,
        now: options.api.now(),
        redemption: 'UNKNOWN',
        alreadyRequested: open !== undefined,
      },
      TRAINING_REVERSAL_POLICY,
    );

    if (decision.outcome === 'REFUSED') {
      response.writeHead(303, {
        location: `/reverse?error=${encodeURIComponent(decision.refusal ?? 'NOT_SAVED')}&transaction=${encodeURIComponent(transactionId)}`,
      });
      response.end();
      return;
    }

    const reference = newSubmissionReference();
    try {
      options.api.driver.saveReversalRequest({
        id: options.api.newId('rev'),
        transactionId,
        merchantId: context.merchantId,
        // Who at the counter asked. A reversal is a claim about what happened
        // in a shop, and the person making it is part of the record.
        requestedBy: context.userId,
        deviceId: context.deviceId,
        reason,
        amountMinor: found.amount_minor,
        redemption: 'UNKNOWN',
        status: decision.outcome === 'ACCEPTED_NEEDS_APPROVAL' ? 'NEEDS_APPROVAL' : 'REQUESTED',
        correlationId: reference,
        at: options.api.now(),
      });
    } catch {
      // The partial unique index fires here: a second open request for the same
      // sale. Filing twice does not make it move faster.
      response.writeHead(303, {
        location: `/reverse?error=REVERSAL_ALREADY_REQUESTED&transaction=${encodeURIComponent(transactionId)}`,
      });
      response.end();
      return;
    }

    response.writeHead(303, { location: `/reverse?sent=${encodeURIComponent(reference)}` });
    response.end();
    return;
  }

  if (path === '/complaint' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/complaint?error=NOT_SAVED' });
      response.end();
      return;
    }

    const transactionId = (form['transactionId'] ?? '').trim();
    const description = (form['description'] ?? '').trim();
    if (transactionId.length === 0) {
      response.writeHead(303, { location: '/complaint?error=TRANSACTION_REQUIRED' });
      response.end();
      return;
    }
    if (description.length === 0) {
      response.writeHead(303, {
        location: `/complaint?error=DESCRIPTION_REQUIRED&transaction=${encodeURIComponent(transactionId)}`,
      });
      response.end();
      return;
    }

    /**
     * Scoped to the session's merchant, never the form's.
     *
     * `findTransaction` takes the merchant id from `context`, so a shop can
     * only report a sale **it made**. A complaint route that trusted a merchant
     * id from the body would let anybody open a case against any shop — and
     * would leak, by its answer, whether a given transaction id exists.
     */
    const found = options.api.driver.findTransaction(
      transactionId as never,
      context.merchantId as never,
    );
    if (found === undefined) {
      response.writeHead(303, { location: '/complaint?error=TRANSACTION_NOT_FOUND' });
      response.end();
      return;
    }

    // One open case per sale. Reporting twice does not make it move faster, and
    // two cases is two people investigating separately.
    const existing = options.api.driver.findSupportCaseByTransaction(
      transactionId as never,
      context.merchantId as never,
    );
    if (existing !== undefined) {
      response.writeHead(303, {
        location: `/complaint?error=ALREADY_REPORTED&transaction=${encodeURIComponent(transactionId)}`,
      });
      response.end();
      return;
    }

    const at = options.api.now();
    const caseId = options.api.newId('case');
    const reference = newSubmissionReference();

    try {
      options.api.driver.transaction((): void => {
        options.api.driver.createSupportCase({
          id: caseId,
          merchantId: context.merchantId as never,
          transactionId: transactionId as never,
          reason: 'MERCHANT_REPORTED',
          reference,
          correlationId: options.api.newId('corr'),
          at: at as never,
        });
        // The case and the shop's own words land together. A case with no
        // description is a case nobody can review.
        options.api.driver.saveComplaintReview({
          id: options.api.newId('cr'),
          supportCaseId: caseId,
          merchantId: context.merchantId,
          description,
          at,
        });
      });
    } catch {
      response.writeHead(303, { location: '/complaint?error=NOT_SAVED' });
      response.end();
      return;
    }

    // Redirected rather than rendered, unlike a device key or a PIN: a case
    // reference is not a secret. It is precisely the thing a shop reads out on
    // the phone, so a URL is the right place for it and the back button works.
    response.writeHead(303, { location: `/complaint?sent=${encodeURIComponent(reference)}` });
    response.end();
    return;
  }

  if (path === '/settings/pin' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/settings?pin=weak' });
      response.end();
      return;
    }
    // Compared here rather than at the API: a PIN typed twice differently is
    // a slip of the finger, and sending it over the wire to be told so would
    // put it there for nothing.
    if (form['newPin'] !== form['confirmPin']) {
      response.writeHead(303, {
        location: '/settings?pin=mismatch',
        ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
      });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/operators/pin',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        currentPin: form['currentPin'],
        newPin: form['newPin'],
      },
    });
    const body = apiResponse.body as { ok: true } | { ok: false; error: { reasonCode: string } };
    response.writeHead(303, {
      // Only ever a code in the URL. A PIN never appears in a location
      // header, a query string, or anywhere else it could reach a log.
      location: body.ok ? '/settings?pin=changed' : `/settings?pin=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/settings/preferences' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/settings?error=ADVERT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/settings',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        soundEnabled: form['soundEnabled'],
        hideBalance: form['hideBalance'],
        lowBalanceAlert: form['lowBalanceAlert'],
        statementsAdminOnly: form['statementsAdminOnly'],
        printBarcode: form['printBarcode'],
        printLookupSlip: form['printLookupSlip'],
        screenLockEnabled: form['screenLockEnabled'],
        lockSeconds: form['lockSeconds'],
      },
    });
    const body = apiResponse.body as { ok: true } | { ok: false; error: { reasonCode: string } };
    response.writeHead(303, {
      location: body.ok ? '/settings?saved=1' : `/settings?error=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/settings/business' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/settings?error=ADVERT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/settings',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        businessName: form['businessName'],
        businessAddress: form['businessAddress'],
        businessPhone: form['businessPhone'],
        businessTin: form['businessTin'],
        businessLicence: form['businessLicence'],
        slipFooter: form['slipFooter'],
      },
    });
    const body = apiResponse.body as { ok: true } | { ok: false; error: { reasonCode: string } };
    response.writeHead(303, {
      location: body.ok ? '/settings?saved=1' : `/settings?error=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/transfer' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/transfer?error=AMOUNT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/transfers',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        recipientDeviceId: form['recipientDeviceId'],
        amountBirr: form['amountBirr'],
        pin: form['pin'],
      },
    });
    const body = apiResponse.body as
      | { ok: true; data: { status: string; amountMinor: number; feeMinor: number } }
      | { ok: false; error: { reasonCode: string } };

    let location: string;
    if (!body.ok) {
      location = `/transfer?error=${encodeURIComponent(body.error.reasonCode)}`;
    } else if (body.data.status === 'NEEDS_APPROVAL') {
      // Deliberately a different parameter from `sent`. An operator told
      // "sent" would tell the other shop to expect money that has not moved.
      location = `/transfer?pending=${encodeURIComponent(String(body.data.amountMinor))}`;
    } else {
      location =
        `/transfer?sent=${encodeURIComponent(String(body.data.amountMinor))}` +
        `&fee=${encodeURIComponent(String(body.data.feeMinor))}` +
        `&to=${encodeURIComponent(form['recipientDeviceId'] ?? '')}`;
    }

    response.writeHead(303, {
      location,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  /**
   * Start a Chapa payment — §20.2.
   *
   * Creates the order, asks Chapa for a checkout page, and sends the shop to a
   * slip carrying both the reference and the link. Nothing has moved yet.
   */
  if (path === '/deposit/chapa' && method === 'POST') {
    if (!isEnabled('deposit.chapa') || options.chapa === undefined) {
      response.writeHead(303, { location: '/deposit/chapa?error=DISABLED' });
      response.end();
      return;
    }
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/deposit/chapa?error=AMOUNT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/deposits/chapa',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], amountBirr: form['amountBirr'] },
    });
    const body = apiResponse.body as
      | { ok: true; data: { reference: string; checkoutUrl: string } }
      | { ok: false; error: { reasonCode: string } };

    response.writeHead(303, {
      location: body.ok
        ? `/deposit/chapa/slip?pay=${encodeURIComponent(body.data.checkoutUrl)}`
        : `/deposit/chapa?error=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  /**
   * Chapa's webhook — §20.2.
   *
   * ## Why this route has no session
   *
   * Chapa is a server on the internet, not a signed-in operator. Its identity is
   * proved by a **signature over the exact bytes it sent**, which is the only
   * thing standing between this endpoint and anyone who can post JSON.
   *
   * ## Why the raw body
   *
   * The signature is over the bytes Chapa hashed. Parsing and re-serialising
   * JSON reorders keys and reformats numbers, producing a different hash and a
   * valid message rejected. So the body is read as bytes, verified, and only
   * then parsed.
   *
   * ## Why it answers 200 to things it refuses
   *
   * A webhook receiver that returns an error gets retried. For a **refused
   * signature** that is a stranger being invited to try again; for an
   * **already-credited** order it is Chapa re-sending an event that was handled
   * correctly the first time. Neither is a problem Chapa can fix by retrying, so
   * both are acknowledged. The one case that *is* worth a retry — Chapa itself
   * being unreachable when Telga tries to verify — answers 503.
   */
  if (path === '/webhooks/chapa' && method === 'POST') {
    if (!isEnabled('deposit.chapa') || options.chapa === undefined) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    const raw = await readBody(request, limit);
    if (raw === 'TOO_LARGE') {
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    const rawText = raw.toString('utf8');

    const verdict = verifyChapaWebhook(request.headers, rawText, options.chapa.secretKey);
    if (verdict !== 'VALID') {
      // Never says which of the two it was. An attacker probing this endpoint
      // learns nothing about whether a signature was close.
      process.stderr.write(`[telga-pos] chapa webhook refused: ${verdict}\n`);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    let txRef = '';
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      txRef = typeof parsed['tx_ref'] === 'string' ? parsed['tx_ref'] : '';
    } catch {
      txRef = '';
    }
    if (txRef.length === 0) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    // The body said something. This asks Chapa.
    const settled = await settleChapaDeposit(
      options.api as never,
      {
        config: { secretKey: options.chapa.secretKey },
        merchantEmail: options.chapa.merchantEmail,
      },
      txRef,
      (prefix) => options.api.newId(prefix),
    );

    if (settled.kind === 'UNVERIFIABLE') {
      // The one case worth retrying: Telga could not reach Chapa to check. §30 —
      // an uncertain outcome is never a failure, and never a credit either.
      process.stderr.write(`[telga-pos] chapa verify unreachable: ${settled.detail}\n`);
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/deposit' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/deposit?error=AMOUNT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/deposits/orders',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], amountBirr: form['amountBirr'] },
    });
    const body = apiResponse.body as
      | { ok: true; data: { reference: string } }
      | { ok: false; error: { reasonCode: string } };
    response.writeHead(303, {
      // Straight to the slip on success: the shopkeeper pressed a button
      // expecting paper, and an intermediate confirmation screen is one more
      // tap between them and the counter.
      location: body.ok ? '/deposit/slip' : `/deposit?error=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/deposit/cancel' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/deposit' });
      response.end();
      return;
    }
    await handle(options.api, {
      method: 'POST',
      path: '/api/training/deposits/orders/cancel',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'] },
    });
    response.writeHead(303, {
      location: '/deposit',
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/profit/transfer' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/profit/transfer?error=AMOUNT_NOT_A_NUMBER' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/profit/transfers',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], amountBirr: form['amountBirr'] },
    });
    const body = apiResponse.body as
      | { ok: true; data: { amountMinor: number } }
      | { ok: false; error: { reasonCode: string } };
    response.writeHead(303, {
      location: body.ok
        ? `/profit/transfer?moved=${encodeURIComponent(String(body.data.amountMinor))}`
        : `/profit/transfer?error=${encodeURIComponent(body.error.reasonCode)}`,
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  if (path === '/orders' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/vouchers/airtime' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/orders',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        network: form['network'],
        productType: form['productType'],
        productId: form['productId'],
        clientRequestId: form['clientRequestId'],
        // Bulk printing. Absent means one, which is what every order was
        // before the stepper existed.
        quantity: form['quantity'],
        // Present only on the top-up form. The API masks it before it is
        // stored, and refuses a `TOPUP` that arrives without one.
        recipient: form['recipient'],
        // The operator types whole birr; the wire and the ledger are minor
        // units. Converting here keeps one representation on the server side.
        customAmountMinor:
          form['customAmountBirr'] !== undefined && form['customAmountBirr'] !== ''
            ? Math.round(Number(form['customAmountBirr']) * 100)
            : undefined,
      },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { orderId: string };
      error?: { reasonCode: string };
    };
    // A refused amount returns to the amount screen carrying the reason, so
    // the operator stays where they can choose a different one.
    const location =
      body.ok && body.data?.orderId !== undefined
        ? `/orders/${encodeURIComponent(body.data.orderId)}`
        : `/vouchers/airtime/${encodeURIComponent(form['network'] ?? '')}/${encodeURIComponent(form['productType'] ?? '')}?error=${encodeURIComponent(body.error?.reasonCode ?? 'AMOUNT_INVALID')}`;
    response.writeHead(303, { location });
    response.end();
    return;
  }

  /**
   * Settings submit. Post/redirect/get, so a refresh re-reads the saved
   * settings rather than resubmitting them.
   *
   * Every field is forwarded as the operator typed it — validation belongs to
   * `writeSettings`, not to this transport hop, and an owner-only refusal is
   * the API's to make: an operator who reaches this URL is refused by
   * `POS_MANAGE_SETTINGS` and told so, rather than being quietly redirected.
   */
  if (path === '/settings' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/settings?error=ADVERT_INVALID' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/settings',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        slipSize: form['slipSize'],
        slipAdvert: form['slipAdvert'] ?? '',
        profitPercent: form['profitPercent'],
      },
    });
    const body = apiResponse.body as { ok: boolean; error?: { reasonCode: string } };
    response.writeHead(303, {
      location: body.ok
        ? '/settings?saved=1'
        : `/settings?error=${encodeURIComponent(body.error?.reasonCode ?? 'SETTINGS_REFUSED')}`,
    });
    response.end();
    return;
  }

  /**
   * Telga Pay training deposit.
   *
   * The one write in this module. Post/redirect/get to a slip whose figures
   * come from the API's own response, so a refresh reprints rather than
   * re-deposits, and a second press of the button carries the same
   * `clientRequestId` and posts once.
   */
  if (path === '/pay/deposit' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/pay/deposit?error=AMOUNT_NOT_A_NUMBER' });
      response.end();
      return;
    }
    const birr = form['amountBirr'];
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/pay/deposits',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        // Whole birr on the form, minor units on the wire and in the ledger.
        amountMinor: birr !== undefined && birr !== '' ? Math.round(Number(birr) * 100) : NaN,
        method: form['method'],
        clientRequestId: form['clientRequestId'],
      },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { depositId: string; amountMinor: number; method: string };
      error?: { reasonCode: string };
    };
    if (body.ok && body.data !== undefined) {
      const slip = new URLSearchParams({
        deposit: body.data.depositId,
        amount: String(body.data.amountMinor),
        method: body.data.method,
      });
      response.writeHead(303, { location: `/pay/deposit/slip?${slip.toString()}` });
      response.end();
      return;
    }
    response.writeHead(303, {
      location: `/pay/deposit?error=${encodeURIComponent(body.error?.reasonCode ?? 'DEPOSIT_REFUSED')}`,
    });
    response.end();
    return;
  }

  const cancelMatch = /^\/orders\/([A-Za-z0-9_]+)\/cancel$/.exec(path);
  if (cancelMatch !== null && method === 'POST') {
    const orderId = cancelMatch[1];
    const form = await readFormBody(request, limit);
    // Cancelling ends the sale, so it ends on the main screen — leaving the
    // operator on the voucher list after they said "stop" was a step they
    // then had to undo. `returnTo` is matched against a fixed list and never
    // used as a URL: a redirect target taken from a form field would be an
    // open redirect waiting to happen.
    let returnTo = '/dashboard';
    if (form !== 'TOO_LARGE') {
      if (form['returnTo'] === 'vouchers') returnTo = '/vouchers';
      await handle(options.api, {
        method: 'POST',
        path: `/api/training/orders/${encodeURIComponent(orderId)}/cancel`,
        query: {},
        headers: { cookie: cookieHeader ?? '' },
        body: { csrfToken: form['csrfToken'] },
      });
    }
    response.writeHead(303, { location: returnTo });
    response.end();
    return;
  }

  /**
   * PIN submit.
   *
   * `form['pin']` exists only inside `form`, which goes out of scope at the
   * end of this branch — it is read once, placed directly into the API
   * request body, and never assigned to any other variable, logged, or put
   * in a URL. Post/redirect/get throughout: a refresh of the destination page
   * re-fetches the order, it never resubmits the PIN.
   */
  const authorizeMatch = /^\/orders\/([A-Za-z0-9_]+)\/authorize$/.exec(path);
  if (authorizeMatch !== null && method === 'POST') {
    const orderId = authorizeMatch[1];
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: `/orders/${encodeURIComponent(orderId)}/authorize` });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: `/api/training/orders/${encodeURIComponent(orderId)}/authorize`,
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], pin: form['pin'] },
    });
    const body = apiResponse.body as { ok: boolean; error?: { reasonCode: string } };
    // A correct PIN must never be re-requested. Only a PIN failure returns to
    // the PIN screen; every business-rule refusal (insufficient balance, an
    // expired or already-closed order, a duplicate) goes to the result screen
    // as a stated failure, because the PIN was accepted and asking again would
    // be both wrong and unexplainable to the operator.
    const reasonCode = body.error?.reasonCode ?? 'SALE_REFUSED';
    const location = body.ok
      ? `/orders/${encodeURIComponent(orderId)}/result`
      : isPinFailure(reasonCode)
        ? `/orders/${encodeURIComponent(orderId)}/authorize?error=${encodeURIComponent(reasonCode)}`
        : `/orders/${encodeURIComponent(orderId)}/result?error=${encodeURIComponent(reasonCode)}`;
    response.writeHead(303, { location });
    response.end();
    return;
  }

  /**
   * Reprint.
   *
   * Post/redirect/get, so refreshing the slip afterwards re-reads it rather
   * than reprinting again. The API records an audit event and nothing else —
   * no sale, no ledger entry, no timestamp change.
   */
  const reprintMatch = /^\/transactions\/([^/]+)\/reprint$/.exec(path);
  if (reprintMatch !== null && method === 'POST') {
    const id = decodeURIComponent(reprintMatch[1]);
    const form = await readFormBody(request, limit);
    const slip = `/transactions/${encodeURIComponent(id)}/slip`;
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: `${slip}?error=REQUEST_TOO_LARGE` });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: `/api/training/transactions/${encodeURIComponent(id)}/reprint`,
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'] },
    });
    const body = apiResponse.body as { ok: boolean; error?: { reasonCode: string } };
    response.writeHead(303, {
      location: body.ok ? slip : `${slip}?error=${encodeURIComponent(body.error?.reasonCode ?? 'REPRINT_FAILED')}`,
    });
    response.end();
    return;
  }

  // The sell form posts here, then redirects to the transaction it created —
  // post/redirect/get, so a browser refresh cannot resubmit the sale.
  if (path === '/sell' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/sell?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/sales',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        productId: form['productId'],
        amountMinor:
          options.catalog.find((entry) => entry.productId === form['productId'])?.amountMinor ?? 0,
        recipient: form['recipient'],
        clientRequestId: form['clientRequestId'],
        simulatedProviderBehaviour: form['simulatedProviderBehaviour'],
      },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { transactionId: string | null };
      error?: { reasonCode: string };
    };
    const location =
      body.ok && body.data?.transactionId
        ? `/transactions/${encodeURIComponent(body.data.transactionId)}`
        : `/sell?error=${encodeURIComponent(body.error?.reasonCode ?? 'SALE_REFUSED')}`;
    response.writeHead(303, { location });
    response.end();
    return;
  }

  if (path === '/enrol' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/enrol?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/auth/devices',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], deviceId: form['deviceId'] },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { deviceId: string; deviceSecret: string };
      error?: { reasonCode: string };
    };
    if (!body.ok) {
      response.writeHead(303, {
        location: `/enrol?error=${encodeURIComponent(body.error?.reasonCode ?? 'ENROLMENT_REFUSED')}`,
      });
      response.end();
      return;
    }
    // The secret is rendered directly rather than redirected to: it must never
    // reach a URL, a history entry or a server log.
    respondHtml(
      response,
      201,
      htmlDocumentAuth(
        options,
        deviceEnrolmentScreen({
          chrome: authChrome(options, locale),
          merchantId: context.merchantId,
          csrfToken: csrfToken ?? '',
          issuedSecret: body.data,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  const screen = await renderScreen(options, {
    path,
    query: url.searchParams,
    context,
    cookieHeader,
    csrfToken,
    nonce,
  });
  if (screen === undefined) {
    response.writeHead(404, htmlHeaders(transport, scheme, nonce));
    response.end('<p data-testid="not-found">No such screen.</p>');
    return;
  }
  respondHtml(response, screen.status, screen.html, transport, scheme, nonce);
}

/**
 * Refuse a screen request.
 *
 * A session problem sends the operator to sign in, carrying where they were
 * going. Anything else — a revoked device, a missing permission — renders
 * access-denied instead, because signing in again would not fix it and looping
 * them through a login they cannot pass is worse than saying no.
 */
function respondRefused(
  options: PosServerOptions,
  response: ServerResponse,
  auth: AuthFailure,
  path: string,
  locale: Locale,
  method: string,
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): void {
  if (auth.reauthenticate) {
    if (method === 'GET') {
      response.writeHead(303, {
        // The login form, not the launcher.
        //
        // This used to send an unauthenticated visitor to the launcher, because
        // the launcher was then the public front door and the sign-in came
        // after choosing a module. That order was reversed on 2026-08-30
        // (D101): **login is the first screen**, and the launcher is now an
        // authenticated one — so sending a session-less request there produced
        // a redirect loop through a screen that would itself refuse.
        //
        // The refusal code and destination ride along so nothing is lost: after
        // signing in the operator resumes where they were going.
        location: `/login?error=${encodeURIComponent(auth.code)}&returnTo=${encodeURIComponent(safeReturnTo(path))}`,
        ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
      });
      response.end();
      return;
    }
    respondHtml(
      response,
      401,
      htmlDocumentAuth(
        options,
        sessionExpiredScreen(authChrome(options, locale), auth.code),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }
  respondHtml(
    response,
    403,
    htmlDocumentAuth(
      options,
      accessDeniedScreen(authChrome(options, locale), auth.code, options.api.newId('corr')),
      locale,
      nonce,
    ),
    transport,
    scheme,
    nonce,
  );
}

function htmlDocumentAuth(
  options: PosServerOptions,
  el: El,
  locale: Locale,
  nonce: string,
): string {
  return htmlDocument(
    renderToHtml(el),
    {
      locale,
      environment: options.environment,
      merchantId: '',
      mode: options.api.mode,
      serverTime: options.api.now(),
    },
    nonce,
  );
}

function respondHtml(
  response: ServerResponse,
  status: number,
  html: string,
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): void {
  response.writeHead(status, htmlHeaders(transport, scheme, nonce));
  response.end(html);
}

/**
 * Write an API response.
 *
 * The security headers are added here too. A JSON response runs no script, so
 * it gets no nonce and its CSP is `script-src 'none'` — which is exactly right
 * for a body that is never meant to be rendered as a document.
 */
function writeApi(
  response: ServerResponse,
  apiResponse: { status: number; headers: Readonly<Record<string, string>>; body: unknown },
  transport: TransportConfig,
  scheme: RequestScheme,
): void {
  const headers: Record<string, string | string[]> = {
    ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    ...apiResponse.headers,
  };
  const setCookie = apiResponse.headers['set-cookie'];
  if (setCookie !== undefined) headers['set-cookie'] = setCookie.split('\n');
  response.writeHead(apiResponse.status, headers);
  response.end(JSON.stringify(apiResponse.body));
}
