/**
 * A bound on how often one **source** may fail to sign in.
 *
 * Security audit of 2026-09-17, finding **M3**.
 *
 * ## The gap
 *
 * `login()` limits attempts per **user id**, and its own comment is right about
 * why: the user id "is what an attacker varies least" when guessing one
 * operator's PIN. What it does not bound is an attacker who varies it. One
 * guess against each of a thousand operator ids spends nobody's budget, because
 * every id carries its own.
 *
 * That is **not** a credential risk on this platform. Signing in also needs a
 * device id and a 256-bit device key, so guessing is not the threat model. It
 * is a **volume** bound: without it, one address may ask this endpoint an
 * unlimited number of questions, each costing a database read.
 *
 * ## The property that matters more than the limit itself
 *
 * **A successful sign-in must cost a shop nothing.** A busy counter signs in
 * many times a day, an idle timeout on each of several tills, a shift change, a
 * device restart, and every till behind one shop's wi-fi shares an address. A
 * limit that counted *every* sign-in would eventually refuse a real shop at its
 * busiest, which is the worst possible moment and precisely the failure this
 * must not introduce.
 *
 * So only failures are counted. An attacker's attempts are almost all failures
 * and a shop's are almost all successes, which separates them without having to
 * tell them apart.
 *
 * These tests drive the **real server over a real socket**, because the
 * throttle lives at the HTTP layer where a connection has an address at all.
 * Calling `login()` directly, as the existing rate-limit tests do, would not
 * reach it.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { LOGIN_FAILURE_MAX_PER_WINDOW, createPosServer } from '@telga/merchant-pos';
import {
  DEVICE_A,
  OPERATOR_A,
  TEST_PIN,
  WRONG_PIN,
  enrolTestDevice,
  makeUiHarness,
  provisionOperator,
} from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  harness?.cleanup();
  harness = undefined;
});

interface Reply {
  readonly status: number;
  readonly location: string;
}

function post(port: number, path: string, form: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
          origin: `http://127.0.0.1:${String(port)}`,
          host: `127.0.0.1:${String(port)}`,
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', () => {
          /* drained; only the redirect matters here */
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers['location'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function start(h: UiHarness): Promise<number> {
  server = createPosServer({
    api: h.api,
    environment: 'test',
    catalog: [],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  });
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

const rateLimited = (reply: Reply): boolean => reply.location.includes('error=RATE_LIMITED');

/** A failed attempt that costs no scrypt: an unknown id is refused before the PIN. */
const probe = (i: number): Record<string, string> => ({
  userId: `probe_operator_${String(i)}`,
  pin: WRONG_PIN,
  deviceId: 'probe_device',
  deviceSecret: 'probe-secret-not-a-real-device-key',
});

describe('one source cannot probe sign-in without limit', () => {
  it('refuses once a source has spent its failure budget, even with a fresh id each time', async () => {
    /**
     * **A different user id every attempt**, which is the whole point. The
     * per-user-id limit in `sessions.ts` never fires here, because each id is
     * new and carries a full budget, so before this change every one of these
     * reached the credential check and came back `INVALID_CREDENTIALS`, for
     * ever.
     */
    harness = makeUiHarness('login-source-throttle');
    const port = await start(harness);

    let refusedAt = -1;
    for (let i = 0; i < LOGIN_FAILURE_MAX_PER_WINDOW + 2; i += 1) {
      if (rateLimited(await post(port, '/login', probe(i)))) {
        refusedAt = i;
        break;
      }
    }

    expect(refusedAt, 'an unlimited number of fresh ids was accepted').toBeGreaterThan(-1);
    // Not before the budget is spent: refusing early would mean a real shop's
    // honest retries are being counted too tightly.
    expect(refusedAt).toBeGreaterThanOrEqual(LOGIN_FAILURE_MAX_PER_WINDOW);
  });

  it('spends none of that budget on a shop that signs in successfully', async () => {
    /**
     * The safety property: a shop that signs in successfully is charged
     * **nothing**. If successes counted, a busy counter (several tills on one
     * wi-fi, an idle timeout on each) would eventually be refused entry to its
     * own till, which is the failure this must not introduce.
     *
     * **Measured as a budget, not as a loop of sign-ins.** The obvious test,
     * signing in more times than the budget allows, proves the wrong thing
     * here: `sessions.ts` separately bounds attempts per user id at ten a
     * minute *"successful or not"*, its own documented burst limit, so a tight
     * loop trips that instead and both refusals look identical in the URL.
     * Thirty scrypt derivations also took the test past its timeout.
     *
     * So: one real sign-in, then count exactly how many failures the budget
     * still allows. If that success had been charged, the count would come up
     * one short. Cheaper, and it measures the thing itself rather than a proxy
     * for it.
     */
    harness = makeUiHarness('login-success-free');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const port = await start(harness);

    const success = await post(port, '/login', {
      userId: String(OPERATOR_A),
      pin: TEST_PIN,
      deviceId: String(DEVICE_A),
      deviceSecret,
    });
    expect(success.location, 'the fixture sign-in should succeed').not.toContain('error=');

    let refusedAt = -1;
    for (let i = 0; i < LOGIN_FAILURE_MAX_PER_WINDOW + 2; i += 1) {
      if (rateLimited(await post(port, '/login', probe(i)))) {
        refusedAt = i;
        break;
      }
    }

    expect(
      refusedAt,
      'a successful sign-in was charged to the source, so the budget tripped early',
    ).toBe(LOGIN_FAILURE_MAX_PER_WINDOW);
  });

  it('does not spend the registration budget, nor let registration spend its own', async () => {
    // `login:` and `activate:` and the bare registration bucket are prefixed
    // apart. A shop registering from the same cafe wi-fi must not make the shop
    // next door unable to sign in.
    harness = makeUiHarness('login-budget-isolated');
    const port = await start(harness);

    for (let i = 0; i < LOGIN_FAILURE_MAX_PER_WINDOW + 2; i += 1) {
      await post(port, '/login', probe(i));
    }

    // The login bucket is now spent. Registration's is untouched, so this is
    // judged on its own merits and never as a throttle.
    const registration = await post(port, '/register', {
      legalName: 'Abebe Trading',
      ownerName: 'Abebe Bekele',
      phone: '+251911000000',
      email: '',
      address: 'Bole Road 12',
      locality: 'Addis Ababa',
      tradeLicence: 'TL-ISOLATION-1',
      tradeLicenceExpiry: '2099-06-30',
      tin: 'TIN-ISOLATION-1',
      photoId: 'ID-ISOLATION-1',
    });

    expect(registration.location).not.toContain('TOO_MANY');
  });
});
