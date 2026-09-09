/**
 * The one route on this platform an unauthenticated stranger may write through.
 *
 * Decision Log **D138** opens `POST /register` so a shop can apply from the
 * Telga app. Everything in this file exists because of that sentence: an
 * endpoint that anybody on the internet may POST to needs a bound on how often,
 * a source it can be bounded *by*, and a rule about what it may disclose.
 *
 * ## What this route can and cannot do
 *
 * It can add a row to `merchant_applications` with `status = 'SUBMITTED'` and
 * `submitted_via = 'SELF_SERVICE'`. That is the whole of its authority. It
 * creates no merchant, no operator, no device, no credential and no session —
 * `Admin Operations Console` Decision 3: *"no account until approved"*, so
 * there is nothing here for an unvetted applicant to attack rather than a
 * locked account guarded on every route.
 */

import { createHash } from 'node:crypto';
import { fromTrustedProxy, normalizeAddress } from './transport/proxy';
import type { ConnectionFacts } from './transport/proxy';
import type { TransportConfig } from './transport/config';

/**
 * How many submissions one source may make, and over what window.
 *
 * Six an hour. A real shop registers **once**; a shop correcting a rejected
 * form might do it three or four times in a sitting, and a number that refuses
 * an honest second attempt costs a merchant. Six leaves room for that and still
 * makes bulk submission from one place pointless.
 *
 * These are training figures. A production limit belongs with a security review
 * and with real traffic to size it against, not with this file.
 */
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATION_MAX_PER_WINDOW = 6;

/**
 * How long an attempt row is kept.
 *
 * Exactly the window, plus a margin so a prune racing a count cannot delete a
 * row the count still needs. §24's retention rule: after the window the row is
 * evidence of nothing and keeping it would be collection without a purpose.
 */
export const REGISTRATION_ATTEMPT_RETENTION_MS = 2 * REGISTRATION_WINDOW_MS;

/**
 * Who to count against, as an opaque token.
 *
 * ## The address is hashed, never stored
 *
 * A throttle needs to know that two requests came from the same place. It does
 * not need to know **where**, and an IP address sitting in a database is
 * personal data under §24's minimization rule with nothing to justify it. So
 * the address is salted and hashed, and only the digest is written.
 *
 * The salt is the deployment's `recipientSalt` — already present, already
 * secret, already the thing this system uses to make a hash unlinkable across
 * deployments. Reusing it means a database copied from one environment cannot
 * be used to test addresses against another.
 *
 * ## Behind a proxy
 *
 * The peer address of a connection through Railway's edge is Railway's, not the
 * shop's — every applicant on earth would share one bucket, and six submissions
 * an hour would be six for the whole planet. So when the peer **is** a trusted
 * proxy, the first entry of `x-forwarded-for` is used instead.
 *
 * `fromTrustedProxy` is what decides that, and it is the same check the scheme
 * resolution uses: a forwarding header from an untrusted peer is ignored, so a
 * caller cannot mint a fresh bucket per request by inventing the header. D45 —
 * there is no trust-all setting — is what makes that hold.
 *
 * **What is still true when nothing is configured:** with no trusted proxy, the
 * header is ignored and every request behind the same edge shares a bucket. The
 * throttle is then coarse rather than absent, which is the safe direction, and
 * the deployment note says to configure `--trust-proxy` for this reason.
 */
export function registrationSource(
  transport: TransportConfig,
  facts: ConnectionFacts,
  salt: string,
): string {
  const peer = facts.remoteAddress;
  let client = normalizeAddress(peer);

  if (fromTrustedProxy(transport, peer)) {
    const forwarded = facts.headers['x-forwarded-for'];
    // The **first** entry: the list grows left-to-right as it is forwarded, so
    // the leftmost is the original client and everything after it is a hop.
    const first = (forwarded ?? '').split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) client = normalizeAddress(first);
  }

  // An empty address hashes to a stable value rather than to nothing, so a
  // connection whose peer cannot be read still lands in *some* bucket instead
  // of escaping the limit entirely.
  return createHash('sha256').update(`registration:${salt}:${client}`).digest('hex');
}

/** What the caller may do next. */
export interface ThrottleVerdict {
  readonly allowed: boolean;
  /** The opaque bucket, so the caller can record the attempt against it. */
  readonly source: string;
}

/**
 * The ports this needs, so it opens nothing itself and a test can drive it.
 */
export interface ThrottlePorts {
  countRegistrationAttemptsSince(source: string, since: string): number;
  recordRegistrationAttempt(source: string, outcome: 'RECORDED' | 'REFUSED', at: string): void;
  pruneRegistrationAttempts(before: string): number;
}

/**
 * May this source submit?
 *
 * Prunes first, so the table cannot grow without bound on a busy deployment,
 * and so the count below reads a table holding only the window it cares about.
 */
export function checkRegistrationThrottle(
  ports: ThrottlePorts,
  source: string,
  now: string,
): ThrottleVerdict {
  const nowMs = Date.parse(now);
  ports.pruneRegistrationAttempts(
    new Date(nowMs - REGISTRATION_ATTEMPT_RETENTION_MS).toISOString(),
  );
  const since = new Date(nowMs - REGISTRATION_WINDOW_MS).toISOString();
  const recent = ports.countRegistrationAttemptsSince(source, since);
  return { allowed: recent < REGISTRATION_MAX_PER_WINDOW, source };
}
