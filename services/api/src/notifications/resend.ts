/**
 * Sending an email — the missing half of the second factor.
 *
 * `services/api/src/auth/emailOtp.ts` has generated, hashed, expired and
 * rate-limited a six-digit sign-in code since migration 017. It is exported,
 * tested, and **has no production caller** — because nothing could put the code
 * in front of a person. This is that.
 *
 * ## Why the console needed it
 *
 * `--single-factor` exists because the founder was made to retype a TOTP code on
 * every high-risk button, and §23.1 says it *"must be off before live money"*.
 * Turning it off with only TOTP available puts an authenticator app between an
 * administrator and their own console. An emailed code is the second factor a
 * person will actually accept, which is what makes that switch flippable rather
 * than theoretical.
 *
 * ## What this deliberately is not
 *
 * Not a notification system. It sends **one kind of message** — a sign-in code —
 * because that is what is needed, and because a general mailer invites a
 * merchant-facing feature to grow here where §24's data-minimisation rules are
 * easy to forget. When something else needs email, it earns its own function
 * with its own reasoning.
 *
 * ## The key
 *
 * Read from `RESEND_API_KEY` by the caller and passed in. §24: *"never commit
 * secrets."* There is no default, and no build ships with one — an unset key
 * means the console falls back to whatever second factor it already had, rather
 * than a build that looks configured and silently sends nothing.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendConfig {
  readonly apiKey: string;
  /**
   * The `from` address. Must be a domain verified in Resend, or Resend refuses.
   *
   * No default: a wrong sender is a deliverability problem discovered in
   * production, and guessing one would hide the configuration step.
   */
  readonly from: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export type SendResult =
  | { readonly kind: 'SENT'; readonly id: string }
  /** Resend answered and refused — bad key, unverified domain, invalid address. */
  | { readonly kind: 'REFUSED'; readonly detail: string }
  /**
   * No usable answer: timeout, network failure, unparseable body.
   *
   * **Distinct from `REFUSED` on purpose.** §30: an uncertain outcome is never
   * reported as a definite one. A code that may have been delivered must not
   * tell an operator it definitely was not.
   */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string };

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The message itself.
 *
 * Deliberately plain text and deliberately short. Three properties matter more
 * than presentation:
 *
 * - **The code is the only variable.** No name, no shop, no device — §24's data
 *   minimisation, and an email that leaks nothing if it reaches the wrong inbox
 *   beyond the fact that somebody tried to sign in.
 * - **It says what to do if it was not you.** An unexpected code is the first
 *   and often only sign that a password has been compromised.
 * - **It never contains a link.** A sign-in email with a clickable link teaches
 *   administrators to click links in sign-in emails, which is the entire
 *   mechanism of a phishing attack against this console.
 */
export const signInCodeEmail = (code: string, minutes: number): { subject: string; text: string } => ({
  subject: `Telga sign-in code: ${code}`,
  text: [
    `Your Telga operations console sign-in code is ${code}.`,
    '',
    `It expires in ${String(minutes)} minutes and can be used once.`,
    '',
    'If you did not try to sign in, somebody else may have your password.',
    'Change it and tell whoever runs Telga.',
    '',
    'Telga will never ask you for this code by phone or message.',
  ].join('\n'),
});

/** Send a sign-in code. The only thing this module sends. */
export async function sendSignInCode(
  config: ResendConfig,
  to: string,
  code: string,
  expiresInMinutes: number,
): Promise<SendResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const message = signInCodeEmail(code, expiresInMinutes);

  try {
    const response = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [to],
        subject: message.subject,
        text: message.text,
      }),
    });

    const raw = await response.text();
    let body: unknown = undefined;
    try {
      body = JSON.parse(raw);
    } catch {
      return { kind: 'UNREACHABLE', detail: `non-JSON response (${String(response.status)})` };
    }

    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (response.ok && typeof record['id'] === 'string') {
      return { kind: 'SENT', id: record['id'] };
    }

    // Resend's own message, which names the actual problem — an unverified
    // domain, a malformed address — and is what an operator needs in the log.
    const detail =
      typeof record['message'] === 'string'
        ? record['message']
        : `Resend refused with status ${String(response.status)}`;
    return { kind: 'REFUSED', detail };
  } catch (error) {
    return { kind: 'UNREACHABLE', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
