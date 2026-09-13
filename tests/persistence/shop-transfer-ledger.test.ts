/**
 * Both sides of a shop-to-shop transfer, in santim — `CLAUDE.md` §19.1.
 *
 * ## The defect these tests close
 *
 * The console's `postTransfer` port read `fromBirr(input.amountMinor / 100)`.
 * `fromBirr` takes **whole birr** and refuses anything else on purpose — *"there
 * is no float path into Money by design"* — so a transfer of 1 500.50 birr
 * arrived as `fromBirr(1500.5)` and threw. The approval route caught it, rolled
 * back and said *"the transfer could not be posted"*, which is true and tells
 * nobody that the amount itself was the problem.
 *
 * A shop could therefore send any round figure and no other. The same expression
 * sat on the reversal and deposit-credit ports, so all three money-moving
 * controls in the console shared it. §13 invariant 9 is the rule it broke:
 * *"money uses integer minor units — never binary floating point."*
 *
 * Everything crossing that boundary was **already** minor units. The fix is to
 * stop converting: `money(minor)`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { money, postingId } from '@telga/domain';
import { fundMerchant, postShopTransfer } from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import { at, DEVICE_A, DEVICE_B, makeHarness, MERCHANT_A, MERCHANT_B, seedMerchant } from './helpers';
import type { Harness } from './helpers';

/** 1 500.50 birr. The amount the old conversion could not express. */
const WITH_SANTIM = 150_050;

let harnesses: Harness[] = [];

function twoShops(name: string, senderMinor = 500_000): SqliteLedgerDriver {
  const h = makeHarness(name);
  harnesses.push(h);
  seedMerchant(h.driver, MERCHANT_A, DEVICE_A);
  seedMerchant(h.driver, MERCHANT_B, DEVICE_B);
  fundMerchant(h.driver, {
    merchantId: MERCHANT_A,
    amount: money(senderMinor),
    at: at(),
    correlationId: 'corr_fund',
    postingId: postingId('post_fund'),
  });
  return h.driver;
}

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

const send = (
  driver: SqliteLedgerDriver,
  input: { amountMinor: number; feeMinor?: number; posting?: string },
): void =>
  postShopTransfer(driver, {
    senderMerchantId: MERCHANT_A,
    recipientMerchantId: MERCHANT_B,
    amount: money(input.amountMinor),
    fee: money(input.feeMinor ?? 0),
    at: at(),
    correlationId: 'corr_transfer',
    postingId: postingId(input.posting ?? 'post_transfer'),
  });

describe('an amount carrying santim', () => {
  it('moves exactly, to the santim', () => {
    const driver = twoShops('transfer-santim');
    send(driver, { amountMinor: WITH_SANTIM });

    // Not 150 000, not 150 100. The figure the shop typed.
    expect(driver.balanceFor(MERCHANT_B).available.minor).toBe(WITH_SANTIM);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(500_000 - WITH_SANTIM);
  });

  it('goes down to a single santim', () => {
    const driver = twoShops('transfer-one-santim');
    // The smallest amount the system can express. `fromBirr(0.01)` refuses it;
    // `money(1)` is what a minor-unit ledger is for.
    send(driver, { amountMinor: 1 });
    expect(driver.balanceFor(MERCHANT_B).available.minor).toBe(1);
  });
});

describe('the posting balances', () => {
  it('debits the sender exactly what it credits the recipient', () => {
    const driver = twoShops('transfer-balanced');
    const before = driver.balanceFor(MERCHANT_A).available.minor;
    send(driver, { amountMinor: WITH_SANTIM });

    const moved = before - driver.balanceFor(MERCHANT_A).available.minor;
    // Money is neither created nor destroyed in the crossing.
    expect(moved).toBe(driver.balanceFor(MERCHANT_B).available.minor);
  });

  it('charges a fee on top of the amount, to the sender only', () => {
    const driver = twoShops('transfer-fee');
    send(driver, { amountMinor: WITH_SANTIM, feeMinor: 250 });

    // §19.1: the recipient gets the amount, never the fee — so both shops agree
    // on one number.
    expect(driver.balanceFor(MERCHANT_B).available.minor).toBe(WITH_SANTIM);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(500_000 - WITH_SANTIM - 250);
  });
});

describe('what the ledger keeps', () => {
  it('leaves the sender able to send the rest', () => {
    const driver = twoShops('transfer-twice');
    send(driver, { amountMinor: WITH_SANTIM, posting: 'post_one' });
    send(driver, { amountMinor: 49_950, posting: 'post_two' });

    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(500_000 - WITH_SANTIM - 49_950);
    expect(driver.balanceFor(MERCHANT_B).available.minor).toBe(WITH_SANTIM + 49_950);
  });
});

/**
 * ## Where the defect actually lived
 *
 * The tests above prove the **ledger** takes minor units exactly. They cannot
 * prove the **console** hands it minor units, because they call
 * `postShopTransfer` directly — and the console's port is what was broken.
 *
 * `run()` builds those ports inline while starting a server, so there is no
 * seam to call them through. The guard is therefore on the source: if
 * `fromBirr(… / 100)` reappears on any money-moving port, this fails. A
 * source-level assertion is a weak test in general; here it is the only one
 * that covers the line that broke.
 */
describe('the console hands over minor units unconverted', () => {
  it('has no float round-trip on any money port', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'apps', 'operations-console', 'src', 'cli.ts'),
      'utf8',
    );
    // Comments are stripped first. The note above the ports *describes* the
    // old expression, and a guard that cannot tell a warning from the thing it
    // warns about fails on its own documentation — which is how the last two
    // source-level guards in this repository first went wrong.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Any `/ 100` reaching a Money constructor is the defect returning.
    expect(code).not.toMatch(/fromBirr\([^)]*\/\s*100/);
  });
});
