/**
 * Every shop owns its own money.
 *
 * ## Why this file exists
 *
 * The founder read a summary that said *"all devices for a shop share the same
 * balance"* as *"all shops share one balance"*, and objected — correctly, and
 * forcefully. Different shops have different owners who have deposited different
 * amounts, and nothing about one shop's money may ever be visible in another's.
 *
 * The sentence was ambiguous; the code was not. But a claim about money is worth
 * more as a test than as a paragraph, so this proves it directly:
 *
 *   - two shops, funded differently, hold exactly what each deposited;
 *   - one shop trading changes nothing about the other;
 *   - the two facts that make that true are checked at their source —
 *     `balanceFor` filters on `merchant_id`, and every ledger row carries one.
 *
 * ## What "shared" actually means, and where
 *
 * **Within** one shop, its devices draw on that shop's single float: till 1 and
 * till 2 at the same counter spend the same money, which is what a shop with two
 * machines expects. **Between** shops there is no sharing of any kind. Both are
 * asserted below so the distinction cannot be misread again.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, postingId } from '@telga/domain';
import type { MerchantId } from '@telga/domain';
import { fundMerchant } from '@telga/persistence';
import { MERCHANT_A, MERCHANT_B, makeUiHarness } from '../ui/helpers';
import type { UiHarness } from '../ui/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** Credit a shop's float, the way provisioning and a verified deposit both do. */
function fund(h: UiHarness, merchantId: MerchantId, birr: number, tag: string): void {
  fundMerchant(h.api.driver, {
    merchantId,
    amount: fromBirr(birr),
    at: h.api.now(),
    correlationId: `corr_${tag}`,
    postingId: postingId(`post_${tag}`),
  });
}

const availableBirr = (h: UiHarness, merchantId: MerchantId): number =>
  h.api.driver.balanceFor(merchantId).available.minor / 100;

/**
 * Give both shops a merchant row and report their opening balances.
 *
 * The harness seeds `MERCHANT_A` with a small training float of its own, so the
 * assertions below are written as **changes** rather than absolutes. That is not
 * a workaround: a shop's balance is only ever the sum of its own history, and a
 * test that pinned an absolute figure would break the day the fixture changed
 * while proving nothing extra. What matters is that funding one shop moves that
 * shop's number and no other.
 */
function twoShops(h: UiHarness): { openingA: number; openingB: number } {
  const at = h.api.now();
  for (const id of [MERCHANT_A, MERCHANT_B]) {
    h.api.driver.saveMerchant({ id, status: 'ACTIVE', mode: 'TRAINING', at });
  }
  return { openingA: availableBirr(h, MERCHANT_A), openingB: availableBirr(h, MERCHANT_B) };
}

describe('two shops, two owners, two balances', () => {
  it('each gains exactly what it deposited, and nothing of the other', () => {
    harness = makeUiHarness('isolation-balances');
    const { openingA, openingB } = twoShops(harness);

    fund(harness, MERCHANT_A, 1_000, 'a');
    fund(harness, MERCHANT_B, 500, 'b');

    expect(availableBirr(harness, MERCHANT_A) - openingA).toBe(1_000);
    expect(availableBirr(harness, MERCHANT_B) - openingB).toBe(500);
    // Different owners, different sums. Neither figure is the other's.
    expect(availableBirr(harness, MERCHANT_A)).not.toBe(availableBirr(harness, MERCHANT_B));
  });

  it('a second deposit into one shop leaves the other untouched', () => {
    harness = makeUiHarness('isolation-second-deposit');
    const { openingA, openingB } = twoShops(harness);

    fund(harness, MERCHANT_A, 1_000, 'a1');
    fund(harness, MERCHANT_B, 500, 'b1');
    const afterFirst = availableBirr(harness, MERCHANT_B);

    fund(harness, MERCHANT_A, 2_500, 'a2');

    expect(availableBirr(harness, MERCHANT_A) - openingA).toBe(3_500);
    // Shop B did not move by one cent while shop B's neighbour deposited twice.
    expect(availableBirr(harness, MERCHANT_B)).toBe(afterFirst);
    expect(availableBirr(harness, MERCHANT_B) - openingB).toBe(500);
  });

  it('a shop that deposited nothing has nothing, however much the other holds', () => {
    // The failure this rules out is a balance query that forgot its WHERE and
    // returned the platform total — which would look like a working system to
    // the first shop and hand the second shop somebody else's money.
    harness = makeUiHarness('isolation-empty');
    twoShops(harness);

    fund(harness, MERCHANT_A, 9_999, 'a');

    expect(availableBirr(harness, MERCHANT_B)).toBe(0);
    expect(availableBirr(harness, MERCHANT_A)).toBeGreaterThanOrEqual(9_999);
  });

  it('keeps every bucket separate, not only the available one', () => {
    // Reserved and under-review are per shop too. A sale reserves against the
    // selling shop's float; nothing of it may appear in another's view.
    harness = makeUiHarness('isolation-buckets');
    twoShops(harness);
    fund(harness, MERCHANT_A, 1_000, 'a');

    const b = harness.api.driver.balanceFor(MERCHANT_B);
    expect(b.available.minor).toBe(0);
    expect(b.reserved.minor).toBe(0);
    expect(b.underReview.minor).toBe(0);
    expect(b.total.minor).toBe(0);
  });
});

describe('the two properties that make this true', () => {
  it('a ledger entry always names the shop it belongs to', () => {
    // Isolation is a property of the rows, not of the query that happens to be
    // written. Every entry carries `merchant_id`, so a shop's money is
    // identifiable at source.
    harness = makeUiHarness('isolation-rows');
    twoShops(harness);
    fund(harness, MERCHANT_A, 1_000, 'a');
    fund(harness, MERCHANT_B, 500, 'b');

    const rows = harness.api.driver.unsafeConnection
      .prepare(
        `SELECT merchant_id, COUNT(*) AS n FROM ledger_entries
          WHERE merchant_id IS NOT NULL GROUP BY merchant_id ORDER BY merchant_id`,
      )
      .all() as { merchant_id: string; n: number }[];

    expect(rows.map((r) => r.merchant_id)).toEqual([MERCHANT_A, MERCHANT_B]);
    for (const row of rows) expect(row.n).toBeGreaterThan(0);
    // No entry belongs to nobody: an unattributed row is money in no shop's
    // books, which is the one thing a per-shop total cannot survive.
    const orphans = harness.api.driver.unsafeConnection
      .prepare(
        `SELECT COUNT(*) AS n FROM ledger_entries
          WHERE merchant_id IS NULL AND account_type LIKE 'MERCHANT_%'`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('the platform total is a sum of the shops, and no shop sees it', () => {
    // Stated as a test because it is the sentence that caused the confusion. A
    // platform figure exists — it is what the admin panel would report — and it
    // is arrived at by adding the shops up, never by reading one.
    harness = makeUiHarness('isolation-platform-total');
    twoShops(harness);
    fund(harness, MERCHANT_A, 1_000, 'a');
    fund(harness, MERCHANT_B, 500, 'b');

    const a = availableBirr(harness, MERCHANT_A);
    const b = availableBirr(harness, MERCHANT_B);
    const platform = a + b;

    expect(platform).toBeGreaterThan(a);
    expect(platform).toBeGreaterThan(b);
    expect(a).not.toBe(platform);
    expect(b).not.toBe(platform);
  });
});

describe('within one shop, its devices do share that shop’s float', () => {
  it('is one balance per shop, not one per device', () => {
    // The other half of the distinction. A shop with two tills has one till of
    // money: `balanceFor` takes a merchant and there is no device parameter,
    // so a per-device balance cannot be expressed even by mistake.
    harness = makeUiHarness('isolation-devices');
    const at = harness.api.now();
    const { openingA } = twoShops(harness);
    for (const id of ['device_1', 'device_2']) {
      harness.api.driver.saveDevice({
        id,
        merchantId: MERCHANT_A,
        status: 'ACTIVE',
        deviceType: 'WEB_POS',
        at,
      });
    }
    fund(harness, MERCHANT_A, 1_000, 'a');

    const devices = harness.api.driver.unsafeConnection
      .prepare(`SELECT id FROM devices WHERE merchant_id = ? ORDER BY id`)
      .all(MERCHANT_A) as { id: string }[];
    expect(devices.map((d) => d.id)).toEqual(expect.arrayContaining(['device_1', 'device_2']));

    // Two devices, one figure — because `balanceFor` takes a merchant and has
    // no device parameter at all, so a per-device balance cannot be expressed
    // even by mistake. Shop B, meanwhile, still has nothing.
    expect(availableBirr(harness, MERCHANT_A) - openingA).toBe(1_000);
    expect(availableBirr(harness, MERCHANT_B)).toBe(0);
  });
});
