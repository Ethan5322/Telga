/**
 * Chapa — the two decisions that stand between a payment and a shop's balance.
 *
 * `CLAUDE.md` §20.2. Chapa is an Ethiopian payment company, used as one *method*
 * of a shop paying money in, beside carrying a slip to a bank counter.
 *
 * A verified Chapa payment credits **automatically**, and these tests are why
 * that is safe. The evidence is Telga asking Chapa directly over an
 * authenticated channel and comparing the answer against an order it created
 * itself — not a human retyping a bank statement, which is the step §20's second
 * approval exists to double-check.
 *
 * So the automation rests on two things being exactly right: the signature that
 * proves a webhook came from Chapa, and the rule that decides whether a verified
 * payment matches the order. Both are pure, and both are tested here.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  PAYLOAD_SIGNATURE_HEADER,
  SECRET_SIGNATURE_HEADER,
  chapaPayloadSignature,
  decideChapaCredit,
  isTestKey,
  santimFrom,
  verifyChapaWebhook,
} from '@telga/provider-chapa';

const SECRET = 'CHASECK_TEST-abc123';
const BODY = JSON.stringify({ event: 'charge.success', tx_ref: 'ABCDEFGHJ', amount: '2500' });

describe('proving a webhook came from Chapa', () => {
  it('accepts a correctly signed payload', () => {
    const headers = { [PAYLOAD_SIGNATURE_HEADER]: chapaPayloadSignature(BODY, SECRET) };
    expect(verifyChapaWebhook(headers, BODY, SECRET)).toBe('VALID');
  });

  it('refuses a body that was altered after signing', () => {
    const signature = chapaPayloadSignature(BODY, SECRET);
    // The attack this stops: the same signature, a bigger amount.
    const tampered = JSON.stringify({ event: 'charge.success', tx_ref: 'ABCDEFGHJ', amount: '250000' });
    expect(verifyChapaWebhook({ [PAYLOAD_SIGNATURE_HEADER]: signature }, tampered, SECRET)).toBe(
      'BAD_SIGNATURE',
    );
  });

  it('refuses a signature made with a different secret', () => {
    const forged = createHmac('sha256', 'CHASECK_TEST-someone-else').update(BODY).digest('hex');
    expect(verifyChapaWebhook({ [PAYLOAD_SIGNATURE_HEADER]: forged }, BODY, SECRET)).toBe(
      'BAD_SIGNATURE',
    );
  });

  it('treats an unsigned request as unsigned', () => {
    expect(verifyChapaWebhook({}, BODY, SECRET)).toBe('UNSIGNED');
    expect(verifyChapaWebhook({ [PAYLOAD_SIGNATURE_HEADER]: '   ' }, BODY, SECRET)).toBe('UNSIGNED');
  });

  /**
   * The deliberate departure from Chapa's own guidance.
   *
   * Chapa says *"if both headers are present but one of the headers is valid,
   * it is sufficient to proceed"*. `chapa-signature` is an HMAC of **the secret
   * itself**, so it is the same constant on every webhook this account will ever
   * receive. It proves the sender once knew the secret and says nothing about
   * whether *this* body was altered or replayed.
   *
   * Accepting it would mean a body could be rewritten — the amount changed —
   * and still verify. So it is not accepted.
   */
  it('refuses a request carrying only the constant secret signature', () => {
    const constant = createHmac('sha256', SECRET).update(SECRET).digest('hex');
    expect(verifyChapaWebhook({ [SECRET_SIGNATURE_HEADER]: constant }, BODY, SECRET)).toBe(
      'UNSIGNED',
    );
  });
});

describe('turning Chapa money into ledger money', () => {
  it('reads birr as integer santim', () => {
    // §13 invariant 9: integer minor units, never binary floating point. Done
    // once, at the edge, so nothing downstream ever sees a float.
    expect(santimFrom('2500')).toBe(250_000);
    expect(santimFrom('2500.50')).toBe(250_050);
    expect(santimFrom('0.05')).toBe(5);
    expect(santimFrom(100)).toBe(10_000);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '-5', '1e3', '1.234', null, undefined, {}]) {
      expect(santimFrom(bad), String(bad)).toBeUndefined();
    }
  });
});

const order = { reference: 'ABCDEFGHJ', amountMinor: 250_000, status: 'OPEN' };
const paid = { status: 'SUCCESS' as const, currency: 'ETB', txRef: 'ABCDEFGHJ', amountMinor: 250_000 };

describe('when a verified payment may credit', () => {
  it('credits when everything agrees', () => {
    expect(decideChapaCredit(paid, order)).toEqual({ kind: 'CREDIT', amountMinor: 250_000 });
  });

  it('credits the amount the order was for, not a figure from the wire', () => {
    const result = decideChapaCredit(paid, order);
    // The order is the authority. Chapa reports; Telga decides against what it
    // asked for.
    expect(result.kind === 'CREDIT' && result.amountMinor).toBe(order.amountMinor);
  });

  it('matches a reference however it was cased or grouped', () => {
    expect(decideChapaCredit({ ...paid, txRef: 'abc-def-ghj' }, order).kind).toBe('CREDIT');
  });
});

describe('when it must not', () => {
  it('refuses anything Chapa has not called a success', () => {
    for (const status of ['PENDING', 'FAILED', 'UNKNOWN'] as const) {
      expect(decideChapaCredit({ ...paid, status }, order)).toEqual({
        kind: 'REFUSE',
        reason: 'NOT_SUCCESSFUL',
      });
    }
  });

  it('refuses a reference that is not this order', () => {
    expect(decideChapaCredit({ ...paid, txRef: 'ZZZZZZZZZ' }, order)).toEqual({
      kind: 'REFUSE',
      reason: 'REFERENCE_MISMATCH',
    });
  });

  it('refuses a different currency', () => {
    expect(decideChapaCredit({ ...paid, currency: 'USD' }, order)).toEqual({
      kind: 'REFUSE',
      reason: 'WRONG_CURRENCY',
    });
  });

  it('refuses an amount that does not match, in either direction', () => {
    expect(decideChapaCredit({ ...paid, amountMinor: 249_900 }, order)).toEqual({
      kind: 'REFUSE',
      reason: 'UNDERPAID',
    });
    // Overpaying is also refused. Crediting the larger figure would let the
    // paying side choose the amount; a person decides instead.
    expect(decideChapaCredit({ ...paid, amountMinor: 250_100 }, order)).toEqual({
      kind: 'REFUSE',
      reason: 'OVERPAID',
    });
  });

  /**
   * The one that makes automatic crediting safe to retry.
   *
   * Chapa retries a webhook until it is acknowledged, so a repeat delivery is
   * ordinary rather than exceptional. An order already `PAID` refuses, which is
   * what stops one payment crediting twice.
   */
  it('refuses an order that has already been credited', () => {
    expect(decideChapaCredit(paid, { ...order, status: 'PAID' })).toEqual({
      kind: 'REFUSE',
      reason: 'ALREADY_CREDITED',
    });
  });

  it('refuses an order that was cancelled or expired', () => {
    for (const status of ['CANCELLED', 'EXPIRED']) {
      expect(decideChapaCredit(paid, { ...order, status })).toEqual({
        kind: 'REFUSE',
        reason: 'ORDER_NOT_OPEN',
      });
    }
  });

  it('settles identity before amount', () => {
    // A payment that is not this order must be told it is not this order —
    // not that its amount is wrong, which answers a question nobody asked and
    // confirms the reference exists.
    expect(decideChapaCredit({ ...paid, txRef: 'ZZZZZZZZZ', amountMinor: 1 }, order)).toEqual({
      kind: 'REFUSE',
      reason: 'REFERENCE_MISMATCH',
    });
  });
});

describe('this build cannot reach live Chapa', () => {
  it('recognises a sandbox key by its prefix', () => {
    expect(isTestKey('CHASECK_TEST-gSCTWzVJoj2Uaw')).toBe(true);
  });

  it('does not mistake a live key for a sandbox one', () => {
    // The guard that matters, because a feature flag is one edit away from
    // being wrong and this is not.
    expect(isTestKey('CHASECK-gSCTWzVJoj2Uaw')).toBe(false);
    expect(isTestKey('')).toBe(false);
  });
});
