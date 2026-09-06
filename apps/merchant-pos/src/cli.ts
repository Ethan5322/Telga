/**
 * The POS entry point.
 *
 * `node apps/merchant-pos/dist/cli.js --db ./telga.sqlite --merchant merchant_alpha`
 *
 * Exit codes follow the worker's conventions, so an operator who has learnt one
 * has learnt both:
 *
 *   0  clean shutdown
 *   2  bad arguments
 *   3  refused: not training mode
 *   4  invalid configuration
 *   5  runtime failure
 *   6  migrations not applied
 *
 * Like the worker, this **does not migrate**. It opens the database and refuses
 * to start if any migration is missing, naming the versions — see
 * `09 Engineering/Migration Ownership.md`. One writer applies migrations, with
 * the worker's `--migrate`; everything else refuses to start without them.
 */

import { randomUUID } from 'node:crypto';
import {
  DEVELOPMENT_RECOVERY_POLICY,
  TRAINING_SESSION_POLICY,
  enrolDevice,
  simulatedCatalog,
  simulatedVoucherCatalog,
  upsertOperator,
} from '@telga/api';
import type { ApiDeps, AuthConfig } from '@telga/api';
import {
  MigrationsNotAppliedError,
  SqliteLedgerDriver,
  assertMigrationsApplied,
  fundMerchant,
} from '@telga/persistence';
import {
  TRAINING_LOCKOUT_POLICY,
  VOUCHER_PIN_LOCKOUT_POLICY,
  fromBirr,
  postingId,
  deviceId as toDeviceId,
  merchantId as toMerchantId,
  merchantUserId as toOperatorId,
  pinRejection,
  productId as toProductId,
  providerId as toProviderId,
  timestamp,
} from '@telga/domain';
import { MOCK_BEHAVIOURS, MockAirtimeProvider } from '@telga/provider-mock-airtime';
import type { MockBehaviour } from '@telga/provider-mock-airtime';
import { isLocale } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { createPosServer } from './server';
import type { PosServerOptions } from './server';
import { LOCAL_HTTP_DEFAULTS, TransportConfigError, isLoopbackHost, validateTransport } from './transport/config';
import type { TransportConfig } from './transport/config';
import { describeTls, loadTlsMaterial } from './transport/tls';

export interface CliArgs {
  readonly db: string;
  readonly port: number;
  readonly merchantId: string;
  readonly deviceId: string;
  readonly operatorId: string;
  readonly environment: string;
  readonly locale: Locale;
  readonly mode: string;
  readonly behaviour: MockBehaviour;
  /**
   * Provision an operator and enrol the device, then print the device key once
   * and exit. The setup path for a fresh training machine.
   */
  readonly provisionPin?: string;
  /** How the deployment is reached. See `09 Engineering/Training HTTPS Deployment.md`. */
  readonly transport: TransportConfig;
  /**
   * Simulated opening balance, in whole birr, credited during provisioning.
   *
   * **Explicit and off by default.** Creating a balance is a money operation
   * even when the money is simulated, so it is a named flag rather than a side
   * effect of setting up an operator. The ledger entry is clearly marked and
   * the schema constrains it to TRAINING.
   */
  readonly trainingFloatBirr?: number;
}

export class CliArgumentError extends Error {
  readonly code = 'POS_BAD_ARGUMENTS';
}

/**
 * Training denominations.
 *
 * **These are not prices.** Real denominations and commission are NOT YET
 * CONFIRMED — see `07 Governance/Decision Log.md`. The labels say "simulated"
 * so a screenshot of this screen cannot be mistaken for a price list.
 */
export const TRAINING_CATALOG = Object.freeze([
  { productId: 'AIRTIME_10', label: 'Airtime 10 (simulated)', amountMinor: 1000, available: true },
  { productId: 'AIRTIME_25', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
  { productId: 'AIRTIME_50', label: 'Airtime 50 (simulated)', amountMinor: 5000, available: true },
  { productId: 'AIRTIME_100', label: 'Airtime 100 (simulated)', amountMinor: 10_000, available: true },
]);

/**
 * The training voucher catalog.
 *
 * Separate from `TRAINING_CATALOG` on purpose: `/sell` and this array's
 * consumers must never share one structure, so a change here cannot alter
 * what `/sell` renders or what the API layer validates a sale against. Every
 * network below is a clearly-labelled placeholder — see
 * `04 UX UI/Voucher Purchase Flow.md`. There is no real South African, or any
 * other, network integration. Amounts are the same approved Birr training
 * denominations `TRAINING_CATALOG` already uses; there is no second currency.
 */
export const TRAINING_VOUCHER_NETWORKS = Object.freeze([
  { id: 'NETWORK_A', label: 'Network A (simulated)' },
  { id: 'NETWORK_B', label: 'Network B (simulated)' },
  { id: 'NETWORK_C', label: 'Network C (simulated)' },
  { id: 'NETWORK_D', label: 'Network D (simulated)' },
] as const);

const TRAINING_VOUCHER_AMOUNTS_MINOR = Object.freeze([1000, 2500, 5000, 10_000] as const);

/**
 * Data bundle categories, as clearly-simulated training values.
 *
 * The founder's list named "FreeMe", which is a **Vodacom trademark**, and
 * asked for real carrier names on the slip. Neither appears here: D66 and
 * CLAUDE.md §10 forbid naming a provider Telga has no agreement with, and a
 * trademark on a training slip would be a claim of association that does not
 * exist. `ALL_ACCESS` carries the same meaning without borrowing a brand.
 *
 * Volumes, validities and prices are training values. They are **not**
 * researched market prices and must not be quoted as any — see `ASSUMPTIONS.md`.
 */
export const TRAINING_DATA_CATEGORIES = Object.freeze([
  { id: 'MONTHLY', label: 'Monthly' },
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'DAILY', label: 'Daily' },
  { id: 'HOURLY', label: 'Hourly' },
  { id: 'WEEKEND', label: 'Weekend' },
  { id: 'ALL_ACCESS', label: 'All-Access' },
  { id: 'LTE', label: 'LTE' },
  { id: 'SOCIAL', label: 'Social' },
  { id: 'VOICE', label: 'Voice' },
] as const);

export type TrainingDataCategory = (typeof TRAINING_DATA_CATEGORIES)[number]['id'];

interface TrainingDataBundle {
  readonly category: TrainingDataCategory;
  /** Short, id-safe suffix. Together with the category it is unique. */
  readonly code: string;
  readonly volumeLabel: string;
  readonly validityDays: number;
  readonly validityLabel: string;
  readonly amountMinor: number;
}

const bundle = (
  category: TrainingDataCategory,
  volumeLabel: string,
  validityDays: number,
  amountMinor: number,
): TrainingDataBundle => ({
  category,
  code: `${volumeLabel.replace(/[^0-9A-Za-z]/g, '')}_${String(validityDays)}D`,
  volumeLabel,
  validityDays,
  validityLabel:
    validityDays === 1 ? '1 day' : `${String(validityDays)} days`,
  amountMinor,
});

export const TRAINING_DATA_BUNDLES: readonly TrainingDataBundle[] = Object.freeze([
  bundle('MONTHLY', '1GB', 30, 12_500),
  bundle('MONTHLY', '3GB', 30, 30_000),
  bundle('MONTHLY', '10GB', 30, 75_000),
  bundle('WEEKLY', '500MB', 7, 5000),
  bundle('WEEKLY', '2GB', 7, 15_000),
  bundle('DAILY', '100MB', 1, 1500),
  bundle('DAILY', '500MB', 1, 4000),
  bundle('HOURLY', '250MB', 1, 2000),
  bundle('WEEKEND', '2GB', 3, 9000),
  bundle('ALL_ACCESS', '5GB', 30, 45_000),
  bundle('LTE', '20GB', 30, 120_000),
  bundle('SOCIAL', '1GB', 7, 6000),
  bundle('VOICE', '100 minutes', 30, 10_000),
]);

export const TRAINING_VOUCHER_CATALOG = Object.freeze(
  TRAINING_VOUCHER_NETWORKS.flatMap((network) => [
    ...TRAINING_VOUCHER_AMOUNTS_MINOR.map((amountMinor) => ({
      productId: `${network.id}_AIRTIME_${amountMinor}`,
      network: network.id,
      productType: 'AIRTIME' as const,
      label: `${network.label} — Airtime ${amountMinor / 100} (simulated)`,
      amountMinor,
      available: true,
      isCustom: false,
    })),
    // One custom entry per network. It stays a real catalog product — the
    // catalog remains the thing the server validates against — but its
    // amount is supplied per order and bounded by
    // `TRAINING_CUSTOM_AMOUNT_LIMITS`. `amountMinor: 0` is a placeholder that
    // no order may use: an order carrying a custom product must supply its
    // own amount, and the server refuses it otherwise.
    {
      productId: `${network.id}_AIRTIME_CUSTOM`,
      network: network.id,
      productType: 'AIRTIME' as const,
      label: `${network.label} — Airtime, custom amount (simulated)`,
      amountMinor: 0,
      available: true,
      isCustom: true,
    },
    // Direct top-up: the same denominations and the same custom entry, but
    // sent to a phone number the operator types rather than handed across the
    // counter as a voucher. It is a separate product id per network so the
    // catalog — which is what the server validates an order against — can
    // tell the two apart without inspecting a flag.
    ...TRAINING_VOUCHER_AMOUNTS_MINOR.map((amountMinor) => ({
      productId: `${network.id}_TOPUP_${amountMinor}`,
      network: network.id,
      productType: 'TOPUP' as const,
      label: `${network.label} — Top-up ${amountMinor / 100} (simulated)`,
      amountMinor,
      available: true,
      isCustom: false,
    })),
    {
      productId: `${network.id}_TOPUP_CUSTOM`,
      network: network.id,
      productType: 'TOPUP' as const,
      label: `${network.label} — Top-up, custom amount (simulated)`,
      amountMinor: 0,
      available: true,
      isCustom: true,
    },
    // Data bundles, one product per category and package.
    ...TRAINING_DATA_BUNDLES.map((bundle) => ({
      productId: `${network.id}_DATA_${bundle.category}_${bundle.code}`,
      network: network.id,
      productType: 'DATA' as const,
      label: `${network.label} — ${bundle.volumeLabel} ${bundle.validityLabel} (simulated)`,
      amountMinor: bundle.amountMinor,
      available: true,
      isCustom: false,
      dataCategory: bundle.category,
      volumeLabel: bundle.volumeLabel,
      validityDays: bundle.validityDays,
      validityLabel: bundle.validityLabel,
    })),
  ]),
);

/**
 * Build the transport configuration from flags.
 *
 * Every unsafe combination is refused here or by `validateTransport`, and both
 * throw a typed error the CLI turns into **exit 4**. There is no flag that says
 * "trust every proxy": that single setting is what turns a spoofed
 * `X-Forwarded-Proto` into a server that believes it is secure when it is not.
 */
export function transportFrom(
  values: Map<string, string>,
  port: number,
): TransportConfig {
  const mode = (values.get('transport') ?? process.env['TELGA_POS_TRANSPORT'] ?? 'HTTP_LOCAL')
    .toUpperCase()
    .replace(/^TRAINING_/, '');
  if (mode !== 'HTTP_LOCAL' && mode !== 'HTTPS') {
    throw new CliArgumentError(
      '--transport must be TRAINING_HTTP_LOCAL or TRAINING_HTTPS',
    );
  }
  const trainingTransport = mode;

  const terminationValue = (values.get('tls-termination') ?? 'IN_PROCESS').toUpperCase();
  if (terminationValue !== 'IN_PROCESS' && terminationValue !== 'TRUSTED_PROXY') {
    throw new CliArgumentError('--tls-termination must be IN_PROCESS or TRUSTED_PROXY');
  }
  const tlsTermination = terminationValue;

  const list = (name: string): readonly string[] => {
    const raw = values.get(name);
    if (raw === undefined || raw.trim().length === 0) return [];
    return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  };

  const trustProxyList = list('trust-proxy');
  const bindHost =
    values.get('host') ??
    process.env['TELGA_POS_HOST'] ??
    (trainingTransport === 'HTTPS' ? '0.0.0.0' : '127.0.0.1');

  const allowedHosts = list('allowed-hosts');
  const hstsEnabled = (values.get('hsts') ?? 'false') === 'true';
  const hstsMaxAge = Number(values.get('hsts-max-age') ?? '15552000');
  if (!Number.isInteger(hstsMaxAge) || hstsMaxAge < 0) {
    throw new CliArgumentError('--hsts-max-age must be a non-negative whole number of seconds');
  }

  const shutdownMs = Number(values.get('shutdown-timeout-ms') ?? '10000');
  if (!Number.isInteger(shutdownMs) || shutdownMs < 0) {
    throw new CliArgumentError('--shutdown-timeout-ms must be a non-negative whole number');
  }

  if (trainingTransport === 'HTTP_LOCAL') {
    return {
      ...LOCAL_HTTP_DEFAULTS,
      bindHost,
      bindPort: port,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : LOCAL_HTTP_DEFAULTS.allowedHosts,
      gracefulShutdownTimeoutMs: shutdownMs,
    };
  }

  return {
    trainingTransport: 'HTTPS',
    bindHost,
    bindPort: port,
    trustProxy: trustProxyList.length > 0 ? trustProxyList : false,
    tlsTermination,
    tlsCertificatePath: values.get('tls-cert') ?? process.env['TELGA_TLS_CERT'],
    tlsPrivateKeyPath: values.get('tls-key') ?? process.env['TELGA_TLS_KEY'],
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : ['localhost', '127.0.0.1'],
    allowedOrigins: list('allowed-origins'),
    // Not configurable to false on HTTPS: `validateTransport` refuses that, and
    // offering the flag would only invite someone to try.
    sessionCookieSecure: true,
    hstsEnabled,
    hstsMaxAgeSeconds: hstsEnabled ? hstsMaxAge : 0,
    gracefulShutdownTimeoutMs: shutdownMs,
  };
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new CliArgumentError(`Unexpected argument: ${arg}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliArgumentError(`Missing value for ${arg}`);
    }
    values.set(arg.slice(2), next);
    i += 1;
  }

  const db = values.get('db') ?? process.env['TELGA_DB'];
  if (!db) throw new CliArgumentError('--db (or TELGA_DB) is required');

  const port = Number(values.get('port') ?? process.env['TELGA_POS_PORT'] ?? '4321');
  // 0 means "let the operating system choose", which a supervised or scripted
  // deployment uses. The banner prints the port actually bound.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliArgumentError('--port must be 0 (choose one) or a valid TCP port');
  }

  const merchantId = values.get('merchant') ?? process.env['TELGA_MERCHANT'];
  if (!merchantId) throw new CliArgumentError('--merchant (or TELGA_MERCHANT) is required');

  const localeValue = values.get('locale') ?? 'en';
  if (!isLocale(localeValue)) throw new CliArgumentError(`--locale must be one of en, am`);

  const behaviour = (values.get('behaviour') ?? 'SUCCESS') as MockBehaviour;
  if (!(MOCK_BEHAVIOURS as readonly string[]).includes(behaviour)) {
    throw new CliArgumentError(`--behaviour must be one of ${MOCK_BEHAVIOURS.join(', ')}`);
  }

  const floatRaw = values.get('training-float');
  let trainingFloatBirr: number | undefined;
  if (floatRaw !== undefined) {
    trainingFloatBirr = Number(floatRaw);
    if (!Number.isInteger(trainingFloatBirr) || trainingFloatBirr <= 0) {
      throw new CliArgumentError('--training-float must be a positive whole number of birr');
    }
  }

  const provisionPin = values.get('provision-pin');
  if (provisionPin !== undefined) {
    const rejected = pinRejection(provisionPin);
    if (rejected) throw new CliArgumentError(`--provision-pin refused: ${rejected}`);
  }

  const transport = transportFrom(values, port);

  return {
    db,
    port,
    merchantId,
    provisionPin,
    trainingFloatBirr,
    transport,
    deviceId: values.get('device') ?? 'device_training_1',
    operatorId: values.get('operator') ?? 'operator_training_1',
    environment: values.get('environment') ?? process.env['TELGA_ENVIRONMENT'] ?? 'local',
    locale: localeValue,
    mode: values.get('mode') ?? process.env['TELGA_MODE'] ?? 'TRAINING',
    behaviour,
  };
}

/**
 * Training auth policy.
 *
 * Every value is the documented **training** figure. Production thresholds are
 * NOT YET CONFIRMED and belong with a security review, not with this file.
 */
export function authConfigFrom(args: CliArgs): AuthConfig {
  return {
    session: TRAINING_SESSION_POLICY,
    lockout: TRAINING_LOCKOUT_POLICY,
    // Separate from `lockout` on purpose: a wrong voucher transaction PIN
    // must never lock a merchant out of signing in. See voucherOrders.ts.
    pinLockout: VOUCHER_PIN_LOCKOUT_POLICY,
    // The API layer's own view of the cookie policy. The POS server refines it
    // per request from the client's actual scheme, because behind a terminator
    // this process speaks HTTP while the client used HTTPS.
    secureCookies: args.transport.sessionCookieSecure,
  };
}

/** Build the server options. Exported so a test can assert the wiring. */
export function optionsFrom(args: CliArgs, driver: SqliteLedgerDriver): PosServerOptions {
  const provider = new MockAirtimeProvider({
    providerId: toProviderId('provider_simulated'),
    behaviour: args.behaviour,
  });

  const api: ApiDeps = {
    driver,
    provider,
    providerId: toProviderId('provider_simulated'),
    // `createSale` validates every sale's productId against this catalog —
    // including a sale created through voucher PIN authorization — so the
    // voucher products are merged in here too, not only into `voucherCatalog`
    // (which governs order *creation*, a separate, earlier check).
    catalog: simulatedCatalog(
      [...TRAINING_CATALOG, ...TRAINING_VOUCHER_CATALOG].map((entry) => ({
        id: toProductId(entry.productId),
        label: entry.label,
        available: entry.available,
      })),
    ),
    voucherCatalog: simulatedVoucherCatalog(
      TRAINING_VOUCHER_CATALOG.map((entry) => ({
        productId: entry.productId,
        network: entry.network,
        productType: entry.productType,
        amountMinor: entry.amountMinor,
        available: entry.available,
        // Forwarded, not dropped. Without it the server treats a custom entry
        // as a fixed denomination and takes its placeholder `amountMinor: 0`
        // as the price — an order for nothing. `tests/ui/helpers.ts` sets this
        // flag on its own fixture, which is why every test passed while the
        // running server did not.
        isCustom: entry.isCustom,
      })),
    ),
    mode: args.mode as ApiDeps['mode'],
    // A per-run salt: this build stores no real recipient, and a salt that
    // survives a restart would be a secret this file has no business holding.
    recipientSalt: randomUUID(),
    now: () => timestamp(new Date().toISOString()),
    newId: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    statusCheckIntervalMs: DEVELOPMENT_RECOVERY_POLICY.statusCheckIntervalMs,
    maxClientPolls: 20,
    maxStatusAttempts: DEVELOPMENT_RECOVERY_POLICY.maxStatusAttempts,
    authConfig: authConfigFrom(args),
    useSimulatedBehaviour: (value) => {
      if (!(MOCK_BEHAVIOURS as readonly string[]).includes(value)) {
        throw new Error(`Unknown simulated behaviour: ${value}`);
      }
      provider.useBehaviour(value as MockBehaviour);
    },
  };

  return {
    api,
    environment: args.environment,
    catalog: TRAINING_CATALOG,
    voucherCatalog: TRAINING_VOUCHER_CATALOG,
    voucherNetworks: TRAINING_VOUCHER_NETWORKS,
    dataCategories: TRAINING_DATA_CATEGORIES,
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
    defaultLocale: args.locale,
    transport: args.transport,
  };
}

/**
 * Provision an operator and enrol the device.
 *
 * Prints the device key **once**, to stdout, and returns. The key is not stored
 * in a recoverable form, so an operator who does not write it down must enrol
 * the device again — which is the property that makes the enrolment worth
 * anything. The PIN is never printed: whoever ran this command already knows it.
 */
export async function provision(args: CliArgs, options: PosServerOptions): Promise<void> {
  const merchantId = toMerchantId(args.merchantId);
  const deviceId = toDeviceId(args.deviceId);
  const at = options.api.now();

  // A fresh training machine has no merchant and no device, and an operator
  // record references both. Creating them here is what makes this a working
  // setup command rather than one that fails on a foreign key — and it is safe
  // precisely because the schema constrains `mode` to TRAINING, so these rows
  // cannot exist for a live deployment.
  if (!options.api.driver.findMerchant(merchantId)) {
    options.api.driver.saveMerchant({ id: merchantId, status: 'ACTIVE', mode: 'TRAINING', at });
  }
  if (!options.api.driver.findDevice(deviceId, merchantId)) {
    options.api.driver.saveDevice({
      id: deviceId,
      merchantId,
      status: 'ACTIVE',
      deviceType: 'WEB_POS',
      at,
    });
  }

  await upsertOperator(options.api, {
    userId: toOperatorId(args.operatorId),
    merchantId,
    displayName: args.operatorId,
    role: 'MERCHANT_OWNER',
    pin: args.provisionPin as string,
  });

  // Simulated opening balance, only when explicitly asked for.
  if (args.trainingFloatBirr !== undefined) {
    fundMerchant(options.api.driver, {
      merchantId,
      amount: fromBirr(args.trainingFloatBirr),
      at,
      correlationId: options.api.newId('corr'),
      postingId: postingId(options.api.newId('post')),
    });
  }

  const enrolled = await enrolDevice(options.api, {
    deviceId,
    merchantId,
    displayName: 'Training device',
    actor: { userId: 'system', role: 'ADMIN' },
    correlationId: options.api.newId('corr'),
  });

  process.stdout.write(
    [
      'Provisioned for TRAINING MODE — NO REAL VALUE.',
      `  operator: ${args.operatorId}`,
      `  merchant: ${args.merchantId}`,
      `  device:   ${args.deviceId}`,
      args.trainingFloatBirr === undefined
        ? '  balance:  none — pass --training-float <birr> to credit a simulated opening balance'
        : `  balance:  ${String(args.trainingFloatBirr)} birr SIMULATED — no real value`,
      '',
      `  device key (shown once, not recoverable): ${enrolled.deviceSecret}`,
      '',
      'Write the device key down now. Telga stores only a hash of it.',
      '',
    ].join('\n'),
  );
}

/**
 * What the operator is told at startup.
 *
 * The scheme is the **client's** view, so a proxied deployment says `https://`
 * even though this process is listening on plain HTTP behind the terminator.
 */
export function startupLines(transport: TransportConfig, boundPort?: number): readonly string[] {
  const scheme = transport.trainingTransport === 'HTTPS' ? 'https' : 'http';
  const host = isLoopbackHost(transport.bindHost) ? 'localhost' : transport.bindHost;
  // The port actually bound, which differs from the configured one when it was
  // 0 and the operating system chose.
  const port = boundPort ?? transport.bindPort;
  const lines = [`Telga POS on ${scheme}://${host}:${String(port)}/login`];

  if (transport.trainingTransport === 'HTTP_LOCAL') {
    lines.push(
      'PLAIN HTTP, LOOPBACK ONLY. Cookies are not marked Secure, because a browser',
      'would never send a Secure cookie back over HTTP. This is a development',
      'fallback, not a training deployment: use --transport TRAINING_HTTPS for that.',
    );
  } else if (transport.tlsTermination === 'TRUSTED_PROXY') {
    lines.push(
      `TLS terminated by a proxy. Forwarding headers are believed ONLY from: ${
        transport.trustProxy === false ? 'nowhere' : transport.trustProxy.join(', ')
      }`,
    );
  }

  lines.push(`Answering for hosts: ${transport.allowedHosts.join(', ')}`);
  if (transport.hstsEnabled) {
    lines.push(`HSTS enabled, max-age ${String(transport.hstsMaxAgeSeconds)}s.`);
  }
  return lines;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (args.mode !== 'TRAINING') {
    process.stderr.write(
      `Refused: the merchant POS serves training mode only; --mode was "${args.mode}"\n`,
    );
    return 3;
  }

  let driver: SqliteLedgerDriver;
  try {
    driver = new SqliteLedgerDriver({ file: args.db });
  } catch (error) {
    process.stderr.write(`Could not open the database: ${(error as Error).message}\n`);
    return 4;
  }

  try {
    assertMigrationsApplied(driver.unsafeConnection);
  } catch (error) {
    driver.close();
    if (error instanceof MigrationsNotAppliedError) {
      process.stderr.write(`${error.message}\n`);
      return 6;
    }
    process.stderr.write(`Could not verify migrations: ${(error as Error).message}\n`);
    return 4;
  }

  // Validate the transport before anything is served, so a bad certificate or
  // an unsafe binding is one clear refusal rather than a per-connection failure
  // that a browser renders as an unexplained error.
  let tlsBanner: readonly string[] = [];
  try {
    validateTransport(args.transport);
    if (
      args.transport.trainingTransport === 'HTTPS' &&
      args.transport.tlsTermination === 'IN_PROCESS'
    ) {
      const material = loadTlsMaterial(
        args.transport.tlsCertificatePath as string,
        args.transport.tlsPrivateKeyPath as string,
      );
      tlsBanner = describeTls(material.summary);
    }
  } catch (error) {
    driver.close();
    if (error instanceof TransportConfigError) {
      process.stderr.write(`Refused: ${error.message} [${error.reasonCode}]\n`);
      return 4;
    }
    process.stderr.write(`Invalid transport configuration: ${(error as Error).message}\n`);
    return 4;
  }

  try {
    const options = optionsFrom(args, driver);

    // `--provision-pin` is a setup command, not a server flag: it creates the
    // operator, enrols the device, prints the key once and exits.
    if (args.provisionPin !== undefined) {
      await provision(args, options);
      return 0;
    }

    const server = createPosServer(options);
    const transport = args.transport;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(transport.bindPort, transport.bindHost, () => {
        const address = server.address();
        const boundPort =
          typeof address === 'object' && address !== null ? address.port : transport.bindPort;
        // The address and the posture. Never a key, never a token — the
        // certificate fingerprint is a public value and is the thing an
        // operator actually needs to confirm.
        process.stdout.write(
          [
            'TRAINING MODE — NO REAL VALUE. Internal training only.',
            ...startupLines(transport, boundPort),
            ...tlsBanner,
            '',
          ].join('\n'),
        );
        resolve();
      });
    });

    // Graceful shutdown: stop accepting, let in-flight requests finish, and
    // give up after the configured timeout rather than hanging forever on a
    // socket a browser is holding open.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const stop = (): void => {
        process.stdout.write('Shutting down: no new connections.\n');
        const timer = setTimeout(() => {
          process.stdout.write('Shutdown timeout reached; closing anyway.\n');
          finish();
        }, transport.gracefulShutdownTimeoutMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  } catch (error) {
    process.stderr.write(`POS failed: ${(error as Error).message}\n`);
    return 5;
  } finally {
    try {
      driver.close();
    } catch {
      // already closed
    }
  }
}

// Run only when invoked directly, so importing this file in a test starts nothing.
if (process.argv[1]?.endsWith('cli.js') === true) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
