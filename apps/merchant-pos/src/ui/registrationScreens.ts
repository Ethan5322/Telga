/**
 * The two screens a shop sees when it registers itself.
 *
 * Decision Log **D138**, and `CLAUDE.md` §18.1. The founder's flow: the Telga
 * app opens on **Login** and **Register as Telga member**; tapping the second gives
 * the form below; submitting it puts an application in the operations console
 * for an admin to read. Nothing here approves anything.
 *
 * ## Why these are not in `authScreens.ts`
 *
 * That module is about proving who you already are. This one is about asking to
 * become someone — no session, no credential, no account, and a refusal policy
 * that is the *opposite* of a sign-in's. Keeping them apart means a change to
 * how login refuses cannot silently change how registration refuses, and the
 * two have genuinely different rules about what a message may disclose.
 *
 * They share `authPage`, so the training banner is still unconditional and no
 * merchant identity is ever displayed on a screen nobody has authenticated to.
 */

import { t } from '@telga/localization';
import { authPage } from './authScreens';
import type { AuthChrome } from './authScreens';
import { h } from './element';
import type { El } from './element';

/**
 * What a refused registration says, in words a shopkeeper can act on.
 *
 * Unlike a sign-in refusal, these **are** specific about which field was wrong,
 * and deliberately so. A sign-in is vague because precision there is a probe
 * for somebody holding a stolen device. A registration has no account to probe
 * for — the person is telling Telga who they are — and a message that will not
 * say what is wrong just loses a real merchant.
 *
 * The one exception is `DOCUMENT_ALREADY_REGISTERED_TO_ANOTHER_SHOP`, which is
 * softened. Saying *"that TIN belongs to another shop"* would confirm to a
 * stranger that a given licence number is registered with Telga, which is a way
 * to test licence numbers against Telga's merchant list. The honest cases — a
 * re-application, a typo — need a person anyway.
 */
const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  LEGAL_NAME_REQUIRED: 'Enter the business name as it appears on the trade licence.',
  OWNER_NAME_REQUIRED: 'Enter the full name of the owner.',
  PHONE_REQUIRED: 'Enter a phone number Telga can call you back on.',
  PHONE_NOT_PLAUSIBLE: 'That phone number does not look complete. Check it and try again.',
  EMAIL_NOT_PLAUSIBLE: 'That email address does not look complete. Correct it, or leave it blank.',
  ADDRESS_REQUIRED: 'Enter the shop address.',
  LOCALITY_REQUIRED: 'Enter the town or sub-city.',
  DOCUMENT_MISSING: 'Trade licence, TIN and owner photo ID are all required.',
  DOCUMENT_REFERENCE_REQUIRED: 'Enter the number printed on each document.',
  DOCUMENT_DUPLICATED: 'The same document number was entered twice. Check each one.',
  LICENCE_EXPIRY_REQUIRED: 'Enter the date the trade licence expires.',
  LICENCE_ALREADY_EXPIRED:
    'That trade licence has expired. Renew it first — Telga cannot register a shop that is not currently licensed to trade.',
  DOCUMENT_ALREADY_REGISTERED_TO_ANOTHER_SHOP:
    'These details could not be registered. Contact Telga so somebody can check them with you.',
  REGISTRATION_NOT_SAVED: 'The registration could not be saved. Try again in a moment.',
  TOO_MANY_ATTEMPTS:
    'Too many registration attempts from this connection. Wait a while and try again.',
  REQUEST_TOO_LARGE: 'That submission was too large. Shorten the entries and try again.',
});

export interface RegistrationProps {
  readonly chrome: AuthChrome;
  /** A refusal code from a previous attempt. */
  readonly refusal?: string;
  /**
   * What was typed last time, so one wrong field costs one correction.
   *
   * A shopkeeper filling this in on a phone behind a counter will abandon a
   * form that empties itself. The console's version of this form does the same
   * thing for the same reason.
   */
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * *Register as Telga member* — the founder's step 2.
 *
 * ## What this screen must never imply
 *
 * That submitting it registers anybody. It does not: it puts an application in
 * a queue, and a Telga admin decides. Any version of this that read like a
 * sign-up — a *Create account* button, a password field, a *Welcome to Telga* —
 * would be a promise the applicant discovers is false days later. So the button
 * says **Send for review**, the intro says what happens next, and there is no
 * password field anywhere, because **no account is created here**.
 *
 * ## Why there are no file uploads
 *
 * The console's version takes scans, because an admin is holding the originals
 * and can see that the scan matches them. This one takes **reference numbers
 * only**. An unauthenticated upload endpoint is a way to put arbitrary bytes on
 * Telga's volume, and the documents must still be seen by a person before
 * approval — so accepting a scan here adds a risk without removing a step. The
 * admin attaches scans at review, where the originals are present.
 */
export function vendorRegistrationScreen(props: RegistrationProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const was = (name: string): string | undefined => props.values?.[name];

  const field = (id: string, label: string, control: El, hint?: string): El =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: id }, label),
      control,
      hint !== undefined && h('p', { id: `${id}-hint`, class: 'field__hint' }, hint),
    );

  const text = (name: string, required: boolean, extra: Record<string, string> = {}): El =>
    h('input', {
      id: name,
      name,
      type: 'text',
      required,
      value: was(name),
      'data-testid': `register-${name}`,
      ...extra,
    });

  return authPage(
    chrome,
    t(locale, 'screen.register'),
    h('h2', { 'data-testid': 'register-heading' }, t(locale, 'register.heading')),
    h('p', { 'data-testid': 'register-intro' }, t(locale, 'register.intro')),
    props.refusal !== undefined &&
      h(
        'p',
        { 'data-testid': 'register-refusal', role: 'alert', 'data-reason-code': props.refusal },
        REFUSAL_TEXT[props.refusal] ?? REFUSAL_TEXT['REGISTRATION_NOT_SAVED'],
      ),
    h(
      'form',
      {
        method: 'post',
        action: '/register',
        'data-testid': 'register-form',
        'aria-label': t(locale, 'screen.register'),
      },
      field(
        'legalName',
        t(locale, 'register.legal_name'),
        text('legalName', true),
        t(locale, 'register.legal_name.hint'),
      ),
      field('ownerName', t(locale, 'register.owner_name'), text('ownerName', true)),
      field(
        'phone',
        t(locale, 'register.phone'),
        text('phone', true, { type: 'tel', inputmode: 'tel', autocomplete: 'tel' }),
        t(locale, 'register.phone.hint'),
      ),
      field(
        'email',
        t(locale, 'register.email'),
        text('email', false, { type: 'email', inputmode: 'email' }),
        t(locale, 'register.email.hint'),
      ),
      field('address', t(locale, 'register.address'), text('address', true)),
      field('locality', t(locale, 'register.locality'), text('locality', true)),

      h('h3', { 'data-testid': 'register-documents' }, t(locale, 'register.documents')),
      h('p', { class: 'field__hint' }, t(locale, 'register.documents.hint')),

      field('tradeLicence', t(locale, 'register.trade_licence'), text('tradeLicence', true)),
      field(
        'tradeLicenceExpiry',
        t(locale, 'register.trade_licence_expiry'),
        h('input', {
          id: 'tradeLicenceExpiry',
          name: 'tradeLicenceExpiry',
          type: 'date',
          required: true,
          value: was('tradeLicenceExpiry'),
          'data-testid': 'register-tradeLicenceExpiry',
        }),
      ),
      field('tin', t(locale, 'register.tin'), text('tin', true)),
      field(
        'photoId',
        t(locale, 'register.photo_id'),
        text('photoId', true),
        t(locale, 'register.photo_id.hint'),
      ),

      h(
        'button',
        { type: 'submit', 'data-testid': 'register-submit' },
        t(locale, 'register.submit'),
      ),
    ),
    h(
      'p',
      { class: 'login__back' },
      h(
        'a',
        { href: '/login', 'data-testid': 'register-back-to-login' },
        t(locale, 'register.have_account'),
      ),
    ),
  );
}

export interface RegistrationSubmittedProps {
  readonly chrome: AuthChrome;
  /** The applicant's only handle on their own application. */
  readonly reference: string;
}

/**
 * What an applicant sees after submitting.
 *
 * The reference is the **only** thing they get back — migration 014 says so in
 * the schema comment on `merchant_applications.reference` — so it is displayed
 * prominently and with an instruction to keep it. There is nothing to sign in
 * to yet, and this screen says so plainly rather than offering a sign-in button
 * that would refuse them.
 */
export function registrationSubmittedScreen(props: RegistrationSubmittedProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return authPage(
    chrome,
    t(locale, 'screen.register'),
    h(
      'section',
      { 'data-testid': 'register-submitted', role: 'status' },
      h('h2', {}, t(locale, 'register.submitted.heading')),
      h(
        'p',
        { 'data-testid': 'register-reference-label' },
        t(locale, 'register.submitted.reference'),
      ),
      h(
        'p',
        { 'data-testid': 'register-reference', class: 'register__reference' },
        props.reference,
      ),
      h('p', { 'data-testid': 'register-next' }, t(locale, 'register.submitted.next')),
      h('p', { 'data-testid': 'register-no-account' }, t(locale, 'register.submitted.no_account')),
    ),
    h(
      'p',
      { class: 'login__back' },
      h(
        'a',
        { href: '/login', 'data-testid': 'register-submitted-to-login' },
        t(locale, 'screen.login'),
      ),
    ),
  );
}
