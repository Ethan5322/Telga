/**
 * The console shows nothing until the second factor is cleared — §23.1.
 *
 * Founder instruction, 2026-09-12: *"be sure that until Resend OTP is verified
 * the admin panel is opaque — nothing seen."*
 *
 * ## The half that already held
 *
 * The **routes** refuse a password-only session outright. `requireMfa` lets it
 * reach exactly one thing, which is presenting a code —
 * `admin-authentication.test.ts` proves it *"can do nothing at all, not even
 * read"*.
 *
 * ## The half that did not
 *
 * The **page** was still drawing the administrator's name, their department and
 * role, and a navigation link to every section of the console. No records, but
 * an identity and a map of the platform — rendered before the person at the
 * keyboard had proved they were that administrator, on a screen anybody
 * standing nearby can read.
 *
 * Sign out is the deliberate exception: an action, not information, and the way
 * out for somebody who opened this by mistake.
 */

import { describe, expect, it } from 'vitest';
import { otpScreen } from '../../apps/operations-console/src/ui/screens';
import { render } from '../../apps/operations-console/src/ui/page';

const chrome = (over: Record<string, unknown> = {}): never =>
  ({
    csrfToken: 'csrf',
    serverTime: '2026-09-12T10:00:00.000Z',
    schemaVersion: '022',
    adminName: 'Muluken Endashaw',
    adminRole: 'PLATFORM_OWNER',
    department: 'PLATFORM',
    mfaSatisfied: false,
    ...over,
  }) as never;

const beforeOtp = render(otpScreen(chrome(), 60, undefined, 'info@telga.pro'));
const afterOtp = render(otpScreen(chrome({ mfaSatisfied: true }), 60, undefined, 'info@telga.pro'));

describe('before the code is entered', () => {
  it('shows no navigation at all', () => {
    expect(beforeOtp).not.toContain('data-testid="console-nav"');
  });

  it('names no section of the console', () => {
    // A map of what Telga runs is worth something on its own.
    for (const section of ['Merchants', 'Deposits', 'Transfers', 'Reversals', 'Admins']) {
      expect(beforeOtp, `${section} must not appear`).not.toContain(`>${section}<`);
    }
  });

  it('does not say whose account this is', () => {
    expect(beforeOtp).not.toContain('Muluken Endashaw');
    expect(beforeOtp).not.toContain('PLATFORM_OWNER');
    expect(beforeOtp).not.toContain('data-testid="console-identity"');
  });

  it('still says a second factor is outstanding', () => {
    // Opaque, not confusing. The reader must know why they can see nothing.
    expect(beforeOtp).toContain('console-mfa-required');
  });

  it('still offers a way out', () => {
    expect(beforeOtp).toContain('data-testid="console-logout"');
  });
});

describe('once the code is accepted', () => {
  it('the console appears', () => {
    expect(afterOtp).toContain('data-testid="console-nav"');
    expect(afterOtp).toContain('Muluken Endashaw');
  });
});

describe('single-factor mode is a different state', () => {
  it('shows the console, because nothing is waiting on a second factor', () => {
    const single = render(
      otpScreen(chrome({ singleFactorAuth: true }), 60, undefined, 'info@telga.pro'),
    );
    expect(single).toContain('data-testid="console-nav"');
    // And says loudly that it is relaxed.
    expect(single).toContain('console-single-factor');
  });
});
