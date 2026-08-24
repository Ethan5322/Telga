/**
 * Training-mode authentication.
 *
 * TRAINING MODE — NO REAL VALUE, and **training-grade security**. What that
 * phrase means concretely, stated here rather than buried:
 *
 *   - The device identifier is a string a browser sends. It is paired with a
 *     server-issued secret and a server-side enrolment record, which is worth
 *     checking — but it is **not hardware attestation**, and a determined
 *     operator can copy both to another machine.
 *   - Cookies are marked `Secure` only when the deployment says it serves
 *     HTTPS. On the controlled training machine that is plain HTTP, so a
 *     session token is exposed to anything on the wire.
 *   - There is no second factor.
 *
 * None of this is production-ready and none of it is claimed to be. It closes
 * A49 for **controlled internal training**: identity now comes from a
 * server-side session rather than a merchant id in a URL.
 */

export * from './context';
export * from './secrets';
export * from './sessions';
export * from './authorize';
export * from './cookies';
