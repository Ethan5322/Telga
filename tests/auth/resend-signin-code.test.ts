/**
 * Sending a sign-in code — the delivery half of the console's second factor.
 *
 * `emailOtp.ts` has generated, hashed, expired and rate-limited a six-digit code
 * since migration 017, and **had no production caller**: nothing could put the
 * code in front of a person. This module is that, and these tests pin the three
 * things about it that are security decisions rather than plumbing.
 */

import { describe, expect, it } from 'vitest';
import { RESEND_ENDPOINT, sendSignInCode, signInCodeEmail } from '@telga/api';

const config = (fetchImpl: typeof fetch) => ({
  apiKey: 're_test_key',
  from: 'Telga <no-reply@telga.example>',
  fetchImpl,
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('what the email contains', () => {
  it('carries the code and how long it lasts', () => {
    const mail = signInCodeEmail('482913', 10);
    expect(mail.subject).toContain('482913');
    expect(mail.text).toContain('482913');
    expect(mail.text).toContain('10 minutes');
  });

  /**
   * The property that matters most, and the least obvious.
   *
   * A sign-in email containing a clickable link teaches administrators to click
   * links in sign-in emails — which is the whole mechanism of a phishing attack
   * against this console. So there is never one.
   */
  it('contains no link of any kind', () => {
    const mail = signInCodeEmail('482913', 10);
    expect(mail.text).not.toMatch(/https?:\/\//i);
    expect(mail.text).not.toMatch(/<a\s/i);
  });

  it('tells the reader what an unexpected code means', () => {
    // An unexpected code is often the first and only sign that a password has
    // been compromised. An email that does not say so wastes that signal.
    expect(signInCodeEmail('482913', 10).text.toLowerCase()).toContain('did not try to sign in');
  });

  it('names nobody and nothing but the code', () => {
    // §24 data minimisation: an email that reaches the wrong inbox should leak
    // nothing beyond the fact that somebody tried to sign in.
    const mail = signInCodeEmail('482913', 10);
    expect(mail.text).not.toMatch(/merchant|shop|device|operator/i);
  });
});

describe('sending it', () => {
  it('posts to Resend with the key as a bearer token', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const result = await sendSignInCode(
      config((url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return Promise.resolve(jsonResponse(200, { id: 'email_123' }));
      }),
      'owner@telga.example',
      '482913',
      10,
    );

    expect(result).toEqual({ kind: 'SENT', id: 'email_123' });
    expect(seenUrl).toBe(RESEND_ENDPOINT);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer re_test_key');

    const body = JSON.parse(String(seenInit?.body)) as { to: string[]; text: string };
    expect(body.to).toEqual(['owner@telga.example']);
    expect(body.text).toContain('482913');
  });

  it('reports a refusal with Resend’s own reason', async () => {
    // An unverified sending domain is the usual first failure, and the operator
    // needs the actual message to fix it.
    const result = await sendSignInCode(
      config(() => Promise.resolve(jsonResponse(403, { message: 'Domain is not verified' }))),
      'owner@telga.example',
      '482913',
      10,
    );
    expect(result).toEqual({ kind: 'REFUSED', detail: 'Domain is not verified' });
  });

  /**
   * §30: an uncertain outcome is never reported as a definite one.
   *
   * A code that may have been delivered must not tell an operator it definitely
   * was not — they would ask for another and lock themselves out on the resend
   * interval.
   */
  it('separates “could not ask” from “was refused”', async () => {
    const network = await sendSignInCode(
      config(() => Promise.reject(new Error('socket hang up'))),
      'owner@telga.example',
      '482913',
      10,
    );
    expect(network.kind).toBe('UNREACHABLE');

    const garbled = await sendSignInCode(
      config(() => Promise.resolve(new Response('<html>502</html>', { status: 502 }))),
      'owner@telga.example',
      '482913',
      10,
    );
    expect(garbled.kind).toBe('UNREACHABLE');
  });

  it('treats a 200 with no id as no answer at all', async () => {
    // Resend acknowledging without an id is not a send. Reporting it as one
    // would have an operator waiting for an email nobody queued.
    const result = await sendSignInCode(
      config(() => Promise.resolve(jsonResponse(200, { ok: true }))),
      'owner@telga.example',
      '482913',
      10,
    );
    expect(result.kind).toBe('REFUSED');
  });
});
