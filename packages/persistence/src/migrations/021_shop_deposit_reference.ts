import type { Migration } from './index';

/**
 * A shop's own deposit reference — `CLAUDE.md` §20.1.
 *
 * ## The gap this closes
 *
 * A shop can pay money in two ways. With a printed slip it quotes a
 * **per-order** reference, and `topup_orders.reference` resolves it. Without
 * one — a standing transfer, a shop that pays in without printing — it needs a
 * **per-shop** code, and that was `device_enrollments.deposit_lookup`.
 *
 * `deposit_lookup` is written by `issueCredentials` and by nothing else. Every
 * shop provisioned through the CLI goes through `enrolDevice` instead, so the
 * column is **NULL for every such shop** and the fallback resolved nothing.
 * Verified 2026-09-11 against the running database: both devices, no lookup.
 *
 * It failed in the safe direction — §20.1, *"a reference that does not resolve
 * goes to a person, never rounded to the nearest shop"* — so no shop was
 * credited wrongly. But an operations desk was being handed manual review for
 * an ordinary payment, which is how a queue becomes a place nobody looks.
 *
 * ## Why on the merchant, not the device
 *
 * §18.3: **money belongs to the shop, not the till.** A deposit credits
 * `balanceFor(merchantId)` and every device draws on it. A per-device reference
 * would imply per-device balances, which §18.3 says is a different product —
 * and a shop with three tills would have three codes for one bank account.
 *
 * ## Why the reference is stored in plaintext
 *
 * Because it is **not a credential**. `depositReference.ts` puts it plainly:
 * *"the opposite of a credential by construction — the worst thing an attacker
 * can do holding somebody else's deposit reference is give them money."* It has
 * to be readable: an admin reads it to a shopkeeper down a phone line, and a
 * hash cannot be read back.
 *
 * That is exactly the property the **device key never had**, which is why using
 * one as a deposit reference was wrong (D125, superseded by §20.1).
 *
 * `UNIQUE` for the same reason `topup_orders.reference` is: two shops sharing a
 * code is one shop credited with another's money, and that must be impossible
 * rather than unlikely.
 */
export const m021ShopDepositReference: Migration = {
  version: '021',
  name: 'shop_deposit_reference',
  sql: `
    -- Nullable: shops provisioned before this migration have none until one is
    -- issued, and a backfill would have to invent codes for shops that may
    -- never need one. The resolver treats NULL as "no per-shop reference",
    -- which is what it is.
    ALTER TABLE merchants ADD COLUMN deposit_reference TEXT;

    -- Two shops cannot share a code. Partial, so the many NULLs do not collide
    -- with each other.
    CREATE UNIQUE INDEX idx_merchants_deposit_reference
      ON merchants(deposit_reference)
      WHERE deposit_reference IS NOT NULL;
  `,
};
