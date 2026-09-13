/**
 * The sign-in code screen names the mailbox it went to — §23.1.
 *
 * ## What went wrong
 *
 * 2026-09-12, from the deployment: *"admin panel sent OTP nowhere and is
 * asking. Where is OTP? Which email did it send to? I opened my Resend account,
 * my personal email, but the OTP did not arrive there."*
 *
 * The code had been sent correctly — to the address on the **Telga admin
 * account**, which is where it always goes. The administrator looked in the
 * inbox of their **mail provider account**, which is a different address
 * entirely and never receives anything.
 *
 * The screen said *"Telga sent a 6-digit code to your email address"*, which is
 * true, unhelpful, and the whole cause of the hunt. It now names the address.
 *
 * ## Why masked
 *
 * By the time this screen renders the password is already proven, so the
 * address discloses nothing to whoever is typing. But a console is often open
 * on a screen other people can see, and the domain alone answers the question
 * that was actually being asked.
 */

import { describe, expect, it } from 'vitest';
import { otpScreen } from '../../apps/operations-console/src/ui/screens';
import { render } from '../../apps/operations-console/src/ui/page';

const chrome = {
  csrfToken: 'csrf',
  singleFactor: false,
  schemaVersion: '022',
} as never;

const lede = (email?: string): string => render(otpScreen(chrome, 60, undefined, email));

describe('the screen says which mailbox', () => {
  it('names the domain in full, because that is the part that answers the question', () => {
    expect(lede('info@telga.pro')).toContain('@telga.pro');
  });

  it('keeps two characters of the name and hides the rest', () => {
    const html = lede('information@telga.pro');
    expect(html).toContain('in');
    // The full local part is not on the page.
    expect(html).not.toContain('information@');
  });

  it('does not leak a different account holder in full', () => {
    expect(lede('gutaraaboy@gmail.com')).not.toContain('gutaraaboy@gmail.com');
    expect(lede('gutaraaboy@gmail.com')).toContain('@gmail.com');
  });

  it('still renders when no address is known', () => {
    // The screen must never fail to draw; a blank sign-in page is worse than a
    // vague one.
    expect(lede(undefined)).toContain('your email address');
  });

  it('refuses to mangle something that is not an address', () => {
    expect(lede('not-an-address')).toContain('your email address');
  });
});

describe('what it still tells everyone', () => {
  it('says how long the code lasts', () => {
    // Sixty seconds is tight enough that a reader needs to know before they go
    // looking for their phone.
    expect(lede('info@telga.pro')).toContain('60 seconds');
  });
});
