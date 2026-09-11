/**
 * The Chapa HTTP client — `CLAUDE.md` §20.2.
 *
 * Chapa is an Ethiopian payment company. A shop pays money **to Chapa**, Chapa
 * tells Telga, and Telga credits that shop's selling balance. It is one *method*
 * of paying in, beside carrying a slip to a bank counter — not a separate
 * feature, and not a wallet.
 *
 * ## Two calls, and why the second one is the important one
 *
 * `initialize` starts a payment and returns a checkout URL the shop is sent to.
 * `verify` asks Chapa, server to server, what actually happened.
 *
 * **Only `verify` may cause a credit.** Chapa's own documentation is explicit:
 * *"Before giving value to a customer based on a webhook notification, always
 * re-query our API to verify the transaction details."* That is the same rule
 * §20.1 already states for bank deposits — *"an SMS alert may be a hint that a
 * payment arrived; it is not evidence"* — arrived at independently by the people
 * who run the payment network.
 *
 * A webhook is a **prompt to look**. What it says about the amount is a claim by
 * whoever posted it; what `verify` says is Chapa's own record.
 *
 * ## The secret key never reaches this file as a literal
 *
 * It is read from the environment by the caller and passed in. §24: *"never
 * commit secrets."* The test key belongs in `CHAPA_SECRET_KEY`, and a build with
 * no key configured simply cannot reach Chapa at all, which is the safe
 * direction for a feature that is switched off by default.
 */

/** Where the sandbox and live APIs live. Same paths, different keys. */
export const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

export interface ChapaConfig {
  /**
   * The merchant secret key. `CHASECK_TEST-…` for the sandbox.
   *
   * **The prefix is load-bearing**: `isTestKey` reads it, and the startup guard
   * refuses a live key while the feature is in training mode.
   */
  readonly secretKey: string;
  readonly baseUrl?: string;
  /** Injected so a test drives this without a network. */
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds. A payment gateway that hangs must not hang a till. */
  readonly timeoutMs?: number;
}

/** A Chapa test key, by its documented prefix. */
export const isTestKey = (secretKey: string): boolean => secretKey.startsWith('CHASECK_TEST-');

export interface InitializeRequest {
  /** Whole birr as a string, as Chapa's API expects. */
  readonly amount: string;
  /** `ETB` or `USD`. Telga only ever sends `ETB`. */
  readonly currency: 'ETB';
  readonly email: string;
  /**
   * Our reference, used as Chapa's `tx_ref`.
   *
   * The **same** code the shop would have quoted on a bank slip. One reference
   * identifies the top-up order in both systems, so a payment is traceable
   * without a second mapping table to drift out of step.
   */
  readonly tx_ref: string;
  /** Where Chapa posts the webhook. */
  readonly callback_url?: string;
  /** Where the shop's browser lands afterwards. */
  readonly return_url?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export type InitializeResult =
  | { readonly kind: 'STARTED'; readonly checkoutUrl: string }
  /** Chapa answered, and refused. The message is Chapa's own. */
  | { readonly kind: 'REFUSED'; readonly message: string }
  /**
   * No usable answer — timeout, network failure, unparseable body.
   *
   * **Deliberately distinct from `REFUSED`.** §30: *"never treat a timeout as a
   * failure."* A payment that may have started must not be reported to a
   * shopkeeper as one that did not.
   */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string };

/** What Chapa says happened. `SUCCESS` is the only value that may credit. */
export type ChapaPaymentStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN';

export type VerifyResult =
  | {
      readonly kind: 'ANSWERED';
      readonly status: ChapaPaymentStatus;
      /** Minor units, converted from Chapa's decimal birr. */
      readonly amountMinor: number;
      readonly currency: string;
      readonly txRef: string;
      /** Chapa's own reference for the payment, for the audit trail. */
      readonly providerReference: string;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNREACHABLE'; readonly detail: string };

const DEFAULT_TIMEOUT_MS = 15_000;

async function call(
  config: ChapaConfig,
  path: string,
  init: RequestInit,
): Promise<{ ok: true; body: unknown; status: number } | { ok: false; detail: string }> {
  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(`${config.baseUrl ?? CHAPA_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body from a payment gateway is not an answer about a
      // payment. Reported as unreachable rather than guessed at.
      return { ok: false, detail: `non-JSON response (${String(response.status)})` };
    }
    return { ok: true, body, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chapa's `message`, which is **not always a string**.
 *
 * A plain refusal sends text. A validation failure sends an object keyed by
 * field: `{"message":{"email":["validation.email"]}}`. The first version of
 * this adapter checked `typeof === 'string'` and fell back to "Chapa refused
 * the payment" — throwing away the only diagnostic, at exactly the moment
 * somebody needs it.
 *
 * Found on the first real call to the sandbox, which is the argument for making
 * one before believing an integration works. Every test until then used a
 * stubbed response shaped the way the documentation described.
 */
export function chapaMessage(message: unknown): string {
  if (typeof message === 'string' && message.trim().length > 0) return message;
  if (typeof message === 'object' && message !== null) {
    const parts: string[] = [];
    for (const [field, problem] of Object.entries(message as Record<string, unknown>)) {
      const text = Array.isArray(problem) ? problem.join(', ') : String(problem);
      parts.push(`${field}: ${text}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  return 'Chapa refused the payment and gave no reason.';
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Start a payment and get the URL to send the shop to. */
export async function initializeChapaPayment(
  config: ChapaConfig,
  request: InitializeRequest,
): Promise<InitializeResult> {
  const result = await call(config, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (!result.ok) return { kind: 'UNREACHABLE', detail: result.detail };

  const body = asRecord(result.body);
  const data = asRecord(body['data']);
  const checkoutUrl = typeof data['checkout_url'] === 'string' ? data['checkout_url'] : undefined;

  if (body['status'] === 'success' && checkoutUrl !== undefined) {
    return { kind: 'STARTED', checkoutUrl };
  }
  return { kind: 'REFUSED', message: chapaMessage(body['message']) };
}

/**
 * Chapa's decimal birr as integer santim.
 *
 * §13 invariant 9: money is integer minor units, never binary floating point.
 * Chapa sends `"100"` or `100.5`; both become santim here, once, at the edge —
 * and nothing downstream ever sees a float.
 */
export function santimFrom(amount: unknown): number | undefined {
  const text = typeof amount === 'number' ? amount.toString() : typeof amount === 'string' ? amount : undefined;
  if (text === undefined) return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return undefined;
  const [whole, fraction = ''] = text.trim().split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

const statusFrom = (value: unknown): ChapaPaymentStatus => {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'success') return 'SUCCESS';
  if (text === 'failed' || text === 'cancelled' || text === 'reversed' || text === 'refunded') return 'FAILED';
  if (text === 'pending') return 'PENDING';
  // Anything Chapa adds later is UNKNOWN, and UNKNOWN never credits. A new
  // status string must not be read as success by omission.
  return 'UNKNOWN';
};

/** Ask Chapa what actually happened. The only thing that may cause a credit. */
export async function verifyChapaPayment(config: ChapaConfig, txRef: string): Promise<VerifyResult> {
  const result = await call(config, `/transaction/verify/${encodeURIComponent(txRef)}`, {
    method: 'GET',
  });
  if (!result.ok) return { kind: 'UNREACHABLE', detail: result.detail };

  const body = asRecord(result.body);
  const data = asRecord(body['data']);

  /**
   * "No such transaction" is an **answer**, not a failure to get one.
   *
   * Chapa says this with **HTTP 400** and `{"status":"failed","data":null}` —
   * not the 404 this code originally checked for, so the check never fired and
   * a definite negative fell through to `UNREACHABLE`.
   *
   * That distinction decides whether a webhook is retried. `UNREACHABLE` earns
   * a 503 and Chapa tries again; for a reference Chapa has no record of, that
   * is a retry loop with no end, because the answer will never change.
   *
   * Found by calling the sandbox with a reference that does not exist. The
   * documentation does not say which status code this uses, and the stubbed
   * tests used the shape the documentation implied.
   */
  if (body['status'] === 'failed' || data['status'] === undefined) {
    return { kind: 'NOT_FOUND' };
  }

  const amountMinor = santimFrom(data['amount']);
  if (body['status'] !== 'success' || amountMinor === undefined) {
    // Chapa answered, but not in a shape that can be acted on. Not a statement
    // about the payment — a failure to learn about it, so it is retried.
    return { kind: 'UNREACHABLE', detail: 'verify response missing a usable amount or status' };
  }

  return {
    kind: 'ANSWERED',
    status: statusFrom(data['status']),
    amountMinor,
    currency: typeof data['currency'] === 'string' ? data['currency'] : '',
    txRef: typeof data['tx_ref'] === 'string' ? data['tx_ref'] : txRef,
    providerReference: typeof data['reference'] === 'string' ? data['reference'] : '',
  };
}
