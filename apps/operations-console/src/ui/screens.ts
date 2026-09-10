/**
 * The console's screens.
 *
 * Each is a pure function of what the server already decided. No screen makes
 * an authorization decision — it renders one. The rule the POS learned the
 * hard way applies doubly here: hiding a control an admin may not use is a
 * courtesy, and treating it as a control is how a hidden button turns out to
 * still answer.
 */

import type { AdminPermission } from '@telga/domain';
import { h, page } from './page';
import type { ConsoleChrome, El } from './page';

/** What the current admin may do, so a screen can omit what would be refused. */
export interface Allowed {
  readonly has: (permission: AdminPermission) => boolean;
}

const field = (
  label: string,
  name: string,
  opts: { type?: string; value?: string; required?: boolean; placeholder?: string } = {},
): El =>
  h(
    'div',
    { class: 'console__field' },
    h('label', { for: name }, label),
    h('input', {
      id: name,
      name,
      type: opts.type ?? 'text',
      value: opts.value,
      required: opts.required,
      placeholder: opts.placeholder,
      'data-testid': `field-${name}`,
    }),
  );

// --- sign in ---------------------------------------------------------------

/**
 * Sign in.
 *
 * One error message for every failure. A wrong password, an unknown email and
 * a suspended account are the same sentence, because telling an attacker which
 * of the three they hit is how an account list gets enumerated.
 */
export function signInScreen(chrome: ConsoleChrome, error?: string): El {
  return page(
    chrome,
    'Sign in',
    error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'signin-error' }, error),
    h(
      'form',
      { method: 'post', action: '/login', 'data-testid': 'signin-form' },
      field('Email', 'email', { type: 'email', required: true }),
      field('Password', 'password', { type: 'password', required: true }),
      h(
        'button',
        { type: 'submit', class: 'console__button', 'data-testid': 'signin-submit' },
        'Sign in',
      ),
    ),
    h(
      'p',
      { class: 'console__note' },
      'Telga staff only. There is no registration here — an account is created by the Platform Owner.',
    ),
  );
}

/**
 * The second factor.
 *
 * Reached only with a session that has cleared the password. Until this is
 * done the session can do exactly one thing, which is this.
 */
export function mfaScreen(chrome: ConsoleChrome, error?: string, enrolled = true): El {
  return page(
    chrome,
    'Confirm it is you',
    error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'mfa-error' }, error),
    // No code appears on this page. It is derived on the admin's own device
    // from the secret shared once at enrolment. An earlier version printed the
    // code here, which exercised the gate and proved nothing.
    enrolled
      ? h(
          'form',
          { method: 'post', action: '/mfa', 'data-testid': 'mfa-form' },
          h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
          field('Six-digit code from your authenticator', 'code', {
            required: true,
            placeholder: '000000',
          }),
          h('button', { type: 'submit', class: 'console__button', 'data-testid': 'mfa-submit' }, 'Confirm'),
        )
      : h(
          'p',
          {},
          h(
            'a',
            { href: '/mfa/enrol', class: 'console__button', 'data-testid': 'mfa-enrol-link' },
            'Set up an authenticator',
          ),
        ),
    h(
      'p',
      { class: 'console__note' },
      'A password alone opens nothing. Until this is confirmed the session cannot read or change anything.',
    ),
  );
}

/**
 * Enrolling an authenticator.
 *
 * The secret is shown **once**, as text rather than a QR code: the console
 * serves no script and draws no images, so there is nothing here to render one
 * with. Every authenticator app accepts a typed key, which is why the string is
 * grouped in fours.
 */
export function mfaEnrolScreen(
  chrome: ConsoleChrome,
  enrolment: { secret: string; uri: string; entry: string },
): El {
  return page(
    chrome,
    'Set up your authenticator',
    h(
      'p',
      { class: 'console__note' },
      'Open your authenticator app, add an account by entering a key, and type this in. ' +
        'It is shown once.',
    ),
    h('p', { class: 'console__token', 'data-testid': 'mfa-secret' }, enrolment.entry),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'mfa-uri' },
      enrolment.uri,
    ),
    h(
      'p',
      { class: 'console__error' },
      'Anyone holding this key can produce your codes. Do not photograph it, message it, ' +
        'or leave this page open.',
    ),
    h(
      'p',
      {},
      h('a', { href: '/mfa', class: 'console__button', 'data-testid': 'mfa-enrol-done' }, 'I have added it'),
    ),
  );
}

/** Re-prove identity before a high-risk action. Asks for the password, not the code. */
export function stepUpScreen(chrome: ConsoleChrome, action: string, error?: string): El {
  return page(
    chrome,
    'Confirm your password',
    error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'stepup-error' }, error),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'stepup-action' },
      `This action needs a fresh confirmation: ${action}`,
    ),
    h(
      'form',
      { method: 'post', action: '/step-up', 'data-testid': 'stepup-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
      h('input', { type: 'hidden', name: 'returnTo', value: action }),
      field('Password', 'password', { type: 'password', required: true }),
      h('button', { type: 'submit', class: 'console__button', 'data-testid': 'stepup-submit' }, 'Confirm'),
    ),
    h(
      'p',
      { class: 'console__note' },
      'Your password, not the six-digit code: this asks whether it is still you at the keyboard.',
    ),
  );
}

// --- dashboard -------------------------------------------------------------

export interface DashboardCounts {
  readonly applicationsAwaiting: number;
  readonly merchantsActive: number;
  readonly devicesActive: number;
  readonly tenantsBehind: number;
  readonly backupsOverdue: number;
  readonly ledgerSound: boolean;
  readonly ledgerNote: string;
  /**
   * Platform totals — the founder's *"total transactions, total volume"*.
   *
   * Sums across shops, which is the **only** aggregate an administrator sees.
   * No shop's line items are reachable from here: `totalSales` is a count and
   * `totalVolumeMinor` a sum, and neither can be opened.
   */
  readonly totalSales: number;
  readonly totalVolumeMinor: number;
  /** Every shop's float added together. A platform figure, never a shop's. */
  readonly totalFloatMinor: number;
  /** Deposits sitting in `MATCHED` or `MANUAL_REVIEW`, waiting for a person. */
  readonly depositsWaiting: number;
  /** Shops whose float has fallen below the alert threshold. */
  readonly shopsLowOnFloat: number;
  /** Trade licences that have expired or expire within thirty days. */
  readonly licencesExpiring: number;
}

export function dashboardScreen(chrome: ConsoleChrome, counts: DashboardCounts): El {
  const stat = (label: string, value: string, id: string): El =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, label),
      h('td', { 'data-testid': id }, value),
    );

  return page(
    { ...chrome, section: 'dashboard' },
    'Dashboard',
    h(
      'table',
      { class: 'console__table', 'data-testid': 'dashboard-stats' },
      h(
        'tbody',
        {},
        stat('Applications awaiting review', String(counts.applicationsAwaiting), 'stat-applications'),
        stat('Active merchants', String(counts.merchantsActive), 'stat-merchants'),
        stat('Active devices', String(counts.devicesActive), 'stat-devices'),
        stat('Tenants behind on schema', String(counts.tenantsBehind), 'stat-tenants-behind'),
        stat('Backups overdue', String(counts.backupsOverdue), 'stat-backups-overdue'),
      ),
    ),

    // Platform totals. Sums across shops and nothing else: an administrator sees
    // how the system is doing, never what a shop sold.
    h('h2', {}, 'Across the platform'),
    h(
      'table',
      { class: 'console__table', 'data-testid': 'dashboard-totals' },
      h(
        'tbody',
        {},
        stat('Sales', String(counts.totalSales), 'stat-total-sales'),
        stat('Volume', birr(counts.totalVolumeMinor), 'stat-total-volume'),
        stat('Float held by shops', birr(counts.totalFloatMinor), 'stat-total-float'),
      ),
    ),

    // Things a person has to do something about. A dashboard that only reports
    // totals tells an operator the system is busy; this tells them what is
    // waiting, which is the difference between a report and an operations screen.
    h('h2', {}, 'Needs attention'),
    h(
      'table',
      { class: 'console__table', 'data-testid': 'dashboard-alerts' },
      h(
        'tbody',
        {},
        stat('Deposits waiting for a decision', String(counts.depositsWaiting), 'alert-deposits'),
        stat('Shops low on float', String(counts.shopsLowOnFloat), 'alert-low-float'),
        stat('Licences expired or expiring', String(counts.licencesExpiring), 'alert-licences'),
      ),
    ),
    // The one figure that must never be reported as "fine" when it is really
    // "we could not look". See `summariseResiduals`.
    h(
      'p',
      {
        class: counts.ledgerSound ? 'console__note' : 'console__error',
        'data-testid': 'dashboard-ledger',
        'data-sound': counts.ledgerSound ? 'true' : 'false',
      },
      counts.ledgerNote,
    ),
  );
}

// --- applications ----------------------------------------------------------

export interface ApplicationRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly legalName: string;
  readonly locality: string;
  readonly createdAt: string;
  /**
   * Who typed it in — `ADMIN` or `SELF_SERVICE`. Migration 018.
   *
   * Optional so a caller that predates D138 still compiles; absent is treated
   * as `ADMIN`, which is what every row written before the column existed was.
   */
  readonly submittedVia?: string;
}

export function applicationsScreen(
  chrome: ConsoleChrome,
  rows: readonly ApplicationRow[],
  allowed: Allowed,
): El {
  return page(
    { ...chrome, section: 'applications' },
    'Applications',
    // Offered only to an admin who could use it. The route refuses regardless —
    // this avoids presenting a dead control, the same rule the Review link uses.
    allowed.has('ADMIN_REVIEW_APPLICATION')
      ? h(
          'p',
          {},
          h(
            'a',
            { href: '/applications/new', class: 'console__button', 'data-testid': 'register-telga-user' },
            'Register Telga User',
          ),
        )
      : '',
    rows.length === 0
      ? h('p', { 'data-testid': 'applications-empty' }, 'No applications yet.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'applications-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Reference'),
              h('th', { scope: 'col' }, 'Shop'),
              h('th', { scope: 'col' }, 'Locality'),
              // The column that tells a reviewer what kind of work this row is.
              h('th', { scope: 'col' }, 'Source'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Submitted'),
              h('th', { scope: 'col' }, ''),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `application-${row.reference}`, 'data-status': row.status },
                h('td', {}, row.reference),
                h('td', {}, row.legalName),
                /**
                 * Verified by a person, or typed by a stranger.
                 *
                 * Until D138 every application came from an admin holding the
                 * papers, and a reviewer could assume somebody had seen them.
                 * That assumption is no longer safe for every row, and a
                 * reviewer who cannot tell the two apart will keep making it —
                 * so the difference is a column, not a detail on another page.
                 *
                 * Stated as **Unverified** rather than "Self-service", because
                 * what the reviewer needs to know is not where it came from but
                 * what it is worth.
                 */
                h(
                  'td',
                  {},
                  h(
                    'span',
                    {
                      class:
                        row.submittedVia === 'SELF_SERVICE'
                          ? 'console__pill console__pill--caution'
                          : 'console__pill',
                      'data-testid': `application-source-${row.reference}`,
                    },
                    row.submittedVia === 'SELF_SERVICE' ? 'Unverified — from app' : 'Admin-recorded',
                  ),
                ),
                h('td', {}, h('span', { class: 'console__pill' }, row.status)),
                h('td', {}, row.createdAt.slice(0, 10)),
                h(
                  'td',
                  {},
                  // Omitted when the admin could not use it. The route refuses
                  // regardless — this only avoids offering a dead control.
                  allowed.has('ADMIN_REVIEW_APPLICATION')
                    ? h(
                        'a',
                        {
                          href: `/applications/${encodeURIComponent(row.id)}`,
                          'data-testid': `application-open-${row.reference}`,
                        },
                        'Review',
                      )
                    : '',
                ),
              ),
            ),
          ),
        ),
  );
}

/**
 * "Register Telga User" — the form an admin fills in at the shop.
 *
 * The founder's seven fields, plus two the schema and the operation need.
 *
 * ## Why there is a City field the founder did not list
 *
 * `merchant_applications.locality` is `NOT NULL`, and it is what the
 * applications list is grouped and searched by. Splitting it out of the address
 * costs the admin one box and makes "every shop in Adama" a query rather than a
 * scan of free text.
 *
 * ## Why the document boxes take numbers and not files
 *
 * This is **M1a**. The founder has decided that licence and ID *images* are
 * stored, for fraud identification — [[Decision Log]] D125 — and that arrives as
 * **M1b**, because handling photographed identity documents well is a security
 * task rather than a form field: encrypted at rest, access behind step-up and
 * itself audited, and a retention policy. Recorded as **R37**. Until then the
 * reference number is captured, which is what a verifier checks against the
 * issuing authority anyway.
 *
 * ## Why nothing is pre-filled and nothing is remembered
 *
 * An admin registers many shops in a day from a laptop that travels. A form that
 * helpfully retained the last shop's TIN is a form that eventually files one
 * shop's documents against another's name.
 */
export interface RegisterShopFormProps {
  readonly chrome: ConsoleChrome;
  /** Shown above the form when a submission was refused. */
  readonly error?: string;
  /** What the admin typed, so a refusal does not empty the form. */
  readonly values?: Readonly<Record<string, string>>;
}

export function registerShopScreen(props: RegisterShopFormProps): El {
  const { chrome, values = {} } = props;

  const field = (
    id: string,
    label: string,
    opts: { required?: boolean; type?: string; hint?: string } = {},
  ): El =>
    h(
      'div',
      { class: 'console__field' },
      h('label', { for: id }, opts.required === false ? `${label} (optional)` : label),
      h('input', {
        id,
        name: id,
        type: opts.type ?? 'text',
        value: values[id] ?? '',
        'data-testid': `field-${id}`,
        ...(opts.required === false ? {} : { required: true }),
      }),
      opts.hint !== undefined ? h('p', { class: 'console__hint' }, opts.hint) : '',
    );

  /**
   * A file input for a scanned document.
   *
   * Never carries a value: a browser will not let a page pre-fill one, and it
   * would be wrong if it could — a refused form must not appear to still hold
   * somebody's passport. The admin re-attaches, which is a second's work and
   * removes any doubt about which file is on the form.
   */
  const scan = (id: string, label: string): El =>
    h(
      'div',
      { class: 'console__field' },
      h('label', { for: id }, label),
      h('input', {
        id,
        name: id,
        type: 'file',
        accept: 'image/jpeg,image/png,application/pdf',
        'data-testid': `field-${id}`,
      }),
    );

  return page(
    { ...chrome, section: 'applications' },
    'Register Telga User',
    props.error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'register-error' }, props.error),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'register-intro' },
      'Recording a registration creates no account, no credentials and no device. ' +
        'It creates an application for review. Approving one is what creates a shop.',
    ),
    h(
      'form',
      {
        method: 'post',
        action: '/applications',
        // Required for the file inputs. The route accepts urlencoded too, so a
        // form posted without scans still records a registration.
        enctype: 'multipart/form-data',
        'data-testid': 'register-form',
      },
      h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),

      h('h2', {}, 'The shop'),
      field('legalName', 'Shop name'),
      field('address', 'Shop address'),
      field('locality', 'City or town'),

      h('h2', {}, 'The owner'),
      field('ownerName', 'Shop owner legal name', { hint: 'Exactly as written on the ID or passport.' }),
      field('phone', 'Phone number', {
        hint: 'The number Telga will call to hand over the sign-in parameters.',
      }),
      field('email', 'Email', { required: false, type: 'email' }),

      h('h2', {}, 'Documents'),
      h(
        'p',
        { class: 'console__hint', 'data-testid': 'register-documents-note' },
        'Photograph or scan each document. JPEG, PNG or PDF, up to 4 MB. ' +
          'Documents are encrypted and only opened with a recorded reason.',
      ),
      field('tradeLicence', 'Business licence number'),
      field('tradeLicenceExpiry', 'Business licence expiry', {
        type: 'date',
        hint: 'A licence that has already expired is refused: the shop is not currently licensed to trade.',
      }),
      scan('tradeLicenceFile', 'Business licence photograph'),
      field('tin', 'TIN number'),
      scan('tinFile', 'TIN certificate photograph'),
      field('photoId', 'ID or passport number'),
      scan('photoIdFile', 'ID or passport photograph'),

      /**
       * **Path B** — admin creation as its own approval. D138.
       *
       * The founder's rule: *"admin creation IS the approval"*. An admin who
       * has the papers in front of them is the review, and making them approve
       * their own submission a second time on the next screen is ceremony, not
       * control.
       *
       * It is a **deliberate opt-in rather than the default**, because the two
       * cases are genuinely different work. An admin at a counter with the
       * originals ticks this. An admin typing up something posted in, or
       * recording a walk-in for a colleague to check, leaves it clear and the
       * application waits in the queue.
       *
       * Ticking it still requires `ADMIN_APPROVE_MERCHANT` on the route, which
       * carries step-up re-authentication with it — so this is a shortcut
       * through a screen, never through a permission.
       */
      h(
        'div',
        { class: 'console__field console__field--check' },
        h('input', {
          id: 'approveNow',
          name: 'approveNow',
          type: 'checkbox',
          value: 'yes',
          'data-testid': 'field-approveNow',
        }),
        h('label', { for: 'approveNow' }, 'Approve immediately — I have seen these documents'),
        h(
          'p',
          { class: 'console__hint' },
          'Creates the shop straight away instead of adding it to the review queue. ' +
            'Leave unticked to have a colleague check it first. ' +
            'Either way, sign-in parameters are issued separately.',
        ),
      ),

      h(
        'p',
        {},
        h(
          'button',
          { type: 'submit', class: 'console__button', 'data-testid': 'register-submit' },
          'Register Telga User',
        ),
      ),
    ),
  );
}

/**
 * The hand-over screen: the four parameters, shown once.
 *
 * ## Why this page is deliberately awkward
 *
 * It is reached only by a `POST`, so it is not in browser history and pressing
 * back does not bring a device key onto the screen again. It offers no copy
 * button and no download — the founder's Step 6 is *"written down, not shared
 * digitally"*, and a page that made it easy to paste a device key into a chat
 * would quietly undo that.
 *
 * The key and PIN exist in this response and nowhere else. The database holds
 * scrypt hashes, so nobody — including Telga — can recover them afterwards.
 * That is the property being protected, and the screen says so.
 */
export interface HandoverProps {
  readonly chrome: ConsoleChrome;
  readonly merchantId: string;
  readonly operatorId: string;
  readonly deviceId: string;
  readonly deviceKey: string;
  readonly temporaryPin: string;
}

export function handoverScreen(props: HandoverProps): El {
  const line = (label: string, value: string, id: string, secret = false): El =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, label),
      h(
        'td',
        { 'data-testid': id, class: secret ? 'console__secret' : undefined },
        value,
      ),
    );

  return page(
    { ...chrome(props), section: 'applications' },
    'Sign-in parameters',
    h(
      'p',
      { class: 'console__warning', role: 'alert', 'data-testid': 'handover-once' },
      'Shown once. Telga stores only hashes of the device key and PIN and cannot ' +
        'show them again. Write them down now and give them to the shop owner in person.',
    ),
    h(
      'table',
      { class: 'console__table', 'data-testid': 'handover-table' },
      h(
        'tbody',
        {},
        line('Merchant ID', props.merchantId, 'handover-merchant'),
        line('Operator ID', props.operatorId, 'handover-operator'),
        line('Device ID', props.deviceId, 'handover-device'),
        line('Device Key', props.deviceKey, 'handover-key', true),
        line('Temporary PIN', props.temporaryPin, 'handover-pin', true),
      ),
    ),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'handover-next' },
      'The operator must change the PIN at first sign-in. If the device key is lost, ' +
        'issue new parameters — it cannot be recovered.',
    ),
    h('p', {}, h('a', { href: '/merchants', 'data-testid': 'handover-done' }, 'Done')),
  );
}

/** Narrowing helper so the props object can carry the chrome alongside the values. */
const chrome = (props: HandoverProps): ConsoleChrome => props.chrome;

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export interface DepositRow {
  readonly id: string;
  readonly merchantId: string | null;
  readonly bankReference: string;
  readonly bankAmountMinor: number | null;
  readonly status: string;
  readonly outcomeReason: string | null;
  readonly decidedBy: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

/**
 * The deposit queue.
 *
 * `05 Operations/Funding Verification`'s state flow, as a list. The two rows
 * that need a person are the ones this screen exists for: `MATCHED`, waiting for
 * a **second** approver because it is over the cap, and `MANUAL_REVIEW`, where
 * the quoted reference resolved to no shop and **must not be guessed at**.
 */
export function depositsScreen(
  chromeIn: ConsoleChrome,
  rows: readonly DepositRow[],
  allowed: Allowed,
): El {
  const waiting = rows.filter((r) => r.status === 'MATCHED' || r.status === 'MANUAL_REVIEW');

  return page(
    { ...chromeIn, section: 'deposits' },
    'Deposits',
    allowed.has('ADMIN_APPROVE_FUNDING')
      ? h(
          'p',
          {},
          h(
            'a',
            { href: '/deposits/new', class: 'console__button', 'data-testid': 'record-deposit' },
            'Record a deposit',
          ),
        )
      : '',
    h(
      'p',
      { class: 'console__note', 'data-testid': 'deposits-waiting' },
      `${String(waiting.length)} waiting for a decision.`,
    ),
    rows.length === 0
      ? h('p', { 'data-testid': 'deposits-empty' }, 'No deposits recorded yet.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'deposits-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Bank reference'),
              h('th', { scope: 'col' }, 'Shop'),
              h('th', { scope: 'col' }, 'Amount'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Why'),
              h('th', { scope: 'col' }, 'Verifier'),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `deposit-${row.bankReference}` },
                h('td', {}, row.bankReference),
                // An unmatched deposit shows a dash, not a nearest guess.
                h('td', {}, row.merchantId ?? '—'),
                h('td', {}, row.bankAmountMinor === null ? '—' : birr(row.bankAmountMinor)),
                h('td', {}, h('span', { class: 'console__pill' }, row.status)),
                h('td', {}, row.outcomeReason ?? ''),
                h('td', {}, row.approvedBy ?? row.decidedBy ?? ''),
              ),
            ),
          ),
        ),
  );
}

export interface RecordDepositProps {
  readonly chrome: ConsoleChrome;
  readonly error?: string;
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * Recording a deposit an operator has checked against the bank.
 *
 * The form asks for the bank's figures **separately** from the shop's claim,
 * because they are different kinds of thing and the difference is the whole
 * control: the claim is what somebody said, the bank record is what an operator
 * read in the bank. CLAUDE.md forbids crediting from a claim alone at L128 and
 * L402, and a form with one amount box would quietly invite exactly that.
 *
 * Leaving the bank fields empty is a legitimate answer — it means *"the bank has
 * no such transaction"* — and produces a rejection rather than a credit.
 */
export function recordDepositScreen(props: RecordDepositProps): El {
  const { values = {} } = props;
  const field = (id: string, label: string, hint?: string, type = 'text'): El =>
    h(
      'div',
      { class: 'console__field' },
      h('label', { for: id }, label),
      h('input', { id, name: id, type, value: values[id] ?? '', 'data-testid': `field-${id}` }),
      hint !== undefined ? h('p', { class: 'console__hint' }, hint) : '',
    );

  return page(
    { ...props.chrome, section: 'deposits' },
    'Record a deposit',
    props.error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'deposit-error' }, props.error),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'deposit-intro' },
      'A slip or a message from a shop is the claim. What you read in the bank is the proof. ' +
        'Leave the bank fields empty if the bank has no such transaction.',
    ),
    h(
      'form',
      { method: 'post', action: '/deposits', 'data-testid': 'deposit-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.chrome.csrfToken ?? '' }),

      h('h2', {}, 'What the shop says'),
      field('quotedReference', 'Reference the shop quoted', 'The device key written on the deposit.'),
      field('claimedAmountBirr', 'Amount claimed (birr)', 'Optional. The bank’s figure is what gets credited.'),

      h('h2', {}, 'What the bank shows'),
      field('bankReference', 'Bank transaction reference'),
      field('bankAmountBirr', 'Amount received (birr)'),
      field('creditedAccount', 'Account credited'),
      field('evidence', 'Evidence', 'Statement line, slip number, or where you checked.'),

      h(
        'p',
        {},
        h(
          'button',
          { type: 'submit', class: 'console__button', 'data-testid': 'deposit-submit' },
          'Record deposit',
        ),
      ),
    ),
  );
}

export interface ApplicationDetail extends ApplicationRow {
  readonly tradingName: string | null;
  readonly ownerName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly address: string;
  readonly decisionReason: string | null;
  /**
   * The paperwork, assessed — `admin/registrationReadiness.ts`.
   *
   * Optional so a caller that predates it still compiles, and absent means the
   * panel is not rendered rather than rendered empty: a reviewer must never be
   * shown a green light computed from nothing.
   */
  readonly readiness?: {
    readonly verdict: string;
    readonly reasons: readonly string[];
    readonly documents: readonly {
      readonly kind: string;
      readonly label: string;
      readonly required: boolean;
      readonly state: string;
      readonly reference: string | null;
      readonly expiresAt: string | null;
      readonly daysToExpiry: number | null;
      readonly documentId: string | null;
    }[];
  };
}

export function applicationDetailScreen(
  chrome: ConsoleChrome,
  application: ApplicationDetail,
  allowed: Allowed,
  error?: string,
): El {
  const row = (label: string, value: string, id: string): El =>
    h('tr', {}, h('th', { scope: 'row' }, label), h('td', { 'data-testid': id }, value));

  /**
   * The paperwork, and the green light.
   *
   * This screen showed **no documents at all**: a reviewer was asked to approve
   * a shop without seeing whether it had supplied a licence, a TIN or an ID,
   * let alone whether any of them were in date. The data existed the whole
   * time, in `merchant_application_documents` and the encrypted vault.
   *
   * ## The verdict is information, never a gate
   *
   * A reviewer may approve a `NOT_READY` application and sometimes should — a
   * licence expiring next week is a real shop with a real problem, not a
   * forgery. What this prevents is that happening **unknowingly**. The decide
   * form below is not disabled by it.
   *
   * ## Why each state gets its own words
   *
   * "Documents incomplete" tells a reviewer nothing about what to say on the
   * phone. Missing, expired, expiring and unscanned are four different
   * conversations, so they read as four different lines.
   */
  const readiness = application.readiness;
  const verdictTone = (verdict: string): string =>
    verdict === 'READY' ? 'good' : verdict === 'READY_WITH_WARNINGS' ? 'warn' : 'bad';
  const verdictWords = (verdict: string): string =>
    verdict === 'READY'
      ? 'READY — every required document is present, in date and scanned'
      : verdict === 'READY_WITH_WARNINGS'
        ? 'READY, WITH WARNINGS — nothing is blocking, but read the notes below'
        : 'NOT READY — something required is missing or expired';
  const stateWords: Readonly<Record<string, string>> = {
    MISSING: 'Not supplied',
    EXPIRED: 'Expired',
    EXPIRING_SOON: 'Expiring soon',
    NO_SCAN: 'Reference only',
    PRESENT: 'In order',
  };
  const stateTone = (state: string): string =>
    state === 'PRESENT' ? 'good' : state === 'MISSING' || state === 'EXPIRED' ? 'bad' : 'warn';

  const readinessPanel = (): El | false =>
    readiness === undefined
      ? false
      : h(
          'section',
          { class: 'console__readiness', 'data-testid': 'application-readiness' },
          h('h2', {}, 'Registration paperwork'),
          h(
            'p',
            {
              class: 'console__pill',
              'data-tone': verdictTone(readiness.verdict),
              'data-testid': 'readiness-verdict',
              'data-verdict': readiness.verdict,
              role: 'status',
            },
            verdictWords(readiness.verdict),
          ),
          readiness.reasons.length > 0 &&
            h(
              'ul',
              { 'data-testid': 'readiness-reasons' },
              ...readiness.reasons.map((reason) => h('li', {}, reason)),
            ),
          h(
            'table',
            { class: 'console__table', 'data-testid': 'readiness-documents' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, 'Document'),
                h('th', { scope: 'col' }, 'Required'),
                h('th', { scope: 'col' }, 'State'),
                h('th', { scope: 'col' }, 'Reference'),
                h('th', { scope: 'col' }, 'Expires'),
                h('th', { scope: 'col' }, ''),
              ),
            ),
            h(
              'tbody',
              {},
              ...readiness.documents.map((document) =>
                h(
                  'tr',
                  { 'data-testid': `readiness-${document.kind}`, 'data-state': document.state },
                  h('td', {}, document.label),
                  h('td', {}, document.required ? 'Yes' : 'Optional'),
                  h(
                    'td',
                    {},
                    h(
                      'span',
                      { class: 'console__pill', 'data-tone': stateTone(document.state) },
                      stateWords[document.state] ?? document.state,
                    ),
                  ),
                  // The number printed on the paper. Never an image, and never
                  // a scan — migration 015.
                  h('td', { class: 'console__mono' }, document.reference ?? '—'),
                  h(
                    'td',
                    {},
                    document.expiresAt === null
                      ? '—'
                      : `${document.expiresAt.slice(0, 10)}${
                          document.daysToExpiry !== null && document.daysToExpiry < 0
                            ? ' (lapsed)'
                            : document.daysToExpiry !== null
                              ? ` (${String(document.daysToExpiry)}d)`
                              : ''
                        }`,
                  ),
                  h(
                    'td',
                    {},
                    // Opening a scan is a data export: it carries its own
                    // permission and its own audit line. Offered only when
                    // there is something to open and somebody who may.
                    document.documentId !== null && allowed.has('ADMIN_EXPORT_DATA')
                      ? h(
                          'a',
                          {
                            href: `/applications/${encodeURIComponent(application.id)}/documents/${encodeURIComponent(document.documentId)}`,
                            'data-testid': `readiness-view-${document.kind}`,
                          },
                          'View scan',
                        )
                      : '',
                  ),
                ),
              ),
            ),
          ),
        );

  const decidable = application.status === 'UNDER_REVIEW';

  return page(
    { ...chrome, section: 'applications' },
    `Application ${application.reference}`,
    error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'application-error' }, error),
    readinessPanel(),
    h(
      'table',
      { class: 'console__table', 'data-testid': 'application-detail' },
      h(
        'tbody',
        {},
        row('Status', application.status, 'detail-status'),
        row('Legal name', application.legalName, 'detail-legal-name'),
        row('Trading name', application.tradingName ?? '—', 'detail-trading-name'),
        row('Owner', application.ownerName, 'detail-owner'),
        row('Phone', application.phone, 'detail-phone'),
        row('Email', application.email ?? '—', 'detail-email'),
        row('Address', `${application.address}, ${application.locality}`, 'detail-address'),
        application.decisionReason !== null
          ? row('Decision reason', application.decisionReason, 'detail-reason')
          : h('tr', { hidden: true }),
      ),
    ),
    // Telga verifies none of the above. Saying so on the screen keeps an
    // approving admin from mistaking a filled form for a checked one.
    h(
      'p',
      { class: 'console__note', 'data-testid': 'application-unverified' },
      'Telga has verified none of this. It is what the applicant typed. Approving creates a shop in ' +
        'training mode only — it does not enable any regulated feature.',
    ),
    application.status === 'SUBMITTED' &&
      allowed.has('ADMIN_REVIEW_APPLICATION') &&
      h(
        'form',
        { method: 'post', action: `/applications/${encodeURIComponent(application.id)}/pick-up`, 'data-testid': 'application-pickup-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
        h(
          'button',
          { type: 'submit', class: 'console__button', 'data-testid': 'application-pickup' },
          'Start review',
        ),
      ),
    decidable &&
      allowed.has('ADMIN_APPROVE_MERCHANT') &&
      h(
        'form',
        { method: 'post', action: `/applications/${encodeURIComponent(application.id)}/decide`, 'data-testid': 'application-decide-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
        h(
          'div',
          { class: 'console__field' },
          h('label', { for: 'reason' }, 'Reason (required to reject or return)'),
          h('input', { id: 'reason', name: 'reason', type: 'text', 'data-testid': 'field-reason' }),
        ),
        h(
          'p',
          {},
          h(
            'button',
            { type: 'submit', name: 'outcome', value: 'APPROVE', class: 'console__button', 'data-testid': 'application-approve' },
            'Approve',
          ),
          ' ',
          h(
            'button',
            { type: 'submit', name: 'outcome', value: 'RETURN_FOR_CORRECTION', class: 'console__button', 'data-testid': 'application-return' },
            'Return for correction',
          ),
          ' ',
          h(
            'button',
            { type: 'submit', name: 'outcome', value: 'REJECT', class: 'console__button console__button--danger', 'data-testid': 'application-reject' },
            'Reject',
          ),
        ),
      ),
  );
}

// --- merchants and devices -------------------------------------------------

export interface MerchantRow {
  readonly id: string;
  readonly status: string;
  readonly devices: number;
  readonly createdAt: string;
  /**
   * **This shop's** available float, in minor units.
   *
   * One figure per shop, summed only from ledger entries carrying that
   * merchant's id. Shop A's money is never part of shop B's number, and there
   * is no query here that could produce a shared one — `available_minor` is a
   * correlated subquery keyed on `m.id`.
   */
  readonly availableMinor: number;
  /**
   * How many transactions this shop has made. **A count, never the rows.**
   *
   * The brief requires an administrator to see shop-level *performance* and
   * **not** individual transactions. A count answers "is this shop trading?"
   * without disclosing what was sold, to whom, or for how much.
   */
  readonly transactions: number;
}

/** Minor units as birr. Integer arithmetic throughout — CLAUDE.md §13.9. */
const birr = (minor: number): string =>
  `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB`;

export function merchantsScreen(
  chrome: ConsoleChrome,
  rows: readonly MerchantRow[],
  allowed: Allowed = new Set(),
): El {
  return page(
    { ...chrome, section: 'merchants' },
    'Merchants',
    rows.length === 0
      ? h('p', { 'data-testid': 'merchants-empty' }, 'No merchants yet.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'merchants-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Merchant'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Devices'),
              h('th', { scope: 'col' }, 'Own balance'),
              h('th', { scope: 'col' }, 'Sales'),
              h('th', { scope: 'col' }, 'Since'),
              allowed.has('ADMIN_REGISTER_DEVICE')
                ? h('th', { scope: 'col' }, 'Sign-in parameters')
                : '',
              allowed.has('ADMIN_SUSPEND_MERCHANT') ? h('th', { scope: 'col' }, 'Trading') : '',
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `merchant-${row.id}` },
                h('td', {}, row.id),
                h('td', {}, h('span', { class: 'console__pill' }, row.status)),
                h('td', {}, String(row.devices)),
                // Each shop's own float. The column is headed "Own balance"
                // rather than "Balance" because the question this screen was
                // built to answer is *whose* money this is.
                h('td', { 'data-testid': `merchant-${row.id}-balance` }, birr(row.availableMinor)),
                // A count. Opening a shop's transactions is deliberately not
                // possible from here — see `MerchantRow.transactions`.
                h('td', { 'data-testid': `merchant-${row.id}-sales` }, String(row.transactions)),
                h('td', {}, row.createdAt.slice(0, 10)),
                // A POST, because the screen it opens shows a device key once.
                // A link would put that key in browser history.
                allowed.has('ADMIN_REGISTER_DEVICE')
                  ? h(
                      'td',
                      {},
                      h(
                        'form',
                        {
                          method: 'post',
                          action: `/merchants/${encodeURIComponent(row.id)}/credentials`,
                        },
                        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                        h(
                          'button',
                          {
                            type: 'submit',
                            class: 'console__button',
                            'data-testid': `merchant-${row.id}-issue`,
                          },
                          'Issue',
                        ),
                      ),
                    )
                  : '',
                // Suspend, or reinstate — whichever the shop is not already.
                // A suspension asks for a reason; reinstating does not, because
                // it returns a shop to normal rather than taking something away.
                allowed.has('ADMIN_SUSPEND_MERCHANT')
                  ? h(
                      'td',
                      {},
                      row.status === 'SUSPENDED'
                        ? h(
                            'form',
                            {
                              method: 'post',
                              action: `/merchants/${encodeURIComponent(row.id)}/reinstate`,
                            },
                            h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                            h(
                              'button',
                              {
                                type: 'submit',
                                class: 'console__button',
                                'data-testid': `merchant-${row.id}-reinstate`,
                              },
                              'Reinstate',
                            ),
                          )
                        : h(
                            'form',
                            {
                              method: 'post',
                              action: `/merchants/${encodeURIComponent(row.id)}/suspend`,
                            },
                            h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                            h('input', {
                              type: 'text',
                              name: 'reason',
                              placeholder: 'Reason',
                              'data-testid': `merchant-${row.id}-reason`,
                            }),
                            h(
                              'button',
                              {
                                type: 'submit',
                                class: 'console__button',
                                'data-testid': `merchant-${row.id}-suspend`,
                              },
                              'Suspend',
                            ),
                          ),
                    )
                  : '',
              ),
            ),
          ),
        ),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'merchants-isolation-note' },
      'Each shop holds its own balance. Figures here are that shop’s alone, and ' +
        'sales is a count — individual transactions are not shown.',
    ),
  );
}

export interface DeviceRow {
  readonly id: string;
  readonly merchantId: string;
  readonly status: string;
  readonly deviceType: string;
  readonly enrollmentState: string | null;
  readonly lastSeenAt: string | null;
  /**
   * A short public name for the key this device holds — never the key.
   *
   * The founder asked for a "masked device key". A key is stored only as a
   * scrypt hash, so there is no value to mask; this is derived from that hash
   * and answers the question the request was really about — *is this the same
   * key as before?* See `admin/deviceKeyCheck.ts`.
   *
   * Absent for a device created but never activated: it has no key, and
   * printing a fingerprint for one would be inventing a fact.
   */
  readonly keyFingerprint?: string;
}

export function devicesScreen(
  chrome: ConsoleChrome,
  rows: readonly DeviceRow[],
  allowed: Allowed,
  /**
   * The result of a key check, shown back to the operator.
   *
   * Added because the route redirected with a `notice` this screen did not
   * render: an admin checked a key, was returned here, and saw nothing at all.
   * A control that answers silently is a control nobody trusts.
   */
  notice?: string,
): El {
  return page(
    { ...chrome, section: 'devices' },
    'Devices',
    notice !== undefined &&
      h('p', { class: 'console__note', role: 'status', 'data-testid': 'devices-notice' }, notice),
    /**
     * Check a key a shop has read out.
     *
     * The founder asked to *see* a device key. Telga cannot: it holds a scrypt
     * hash and nothing else. What an operations desk actually needs from that
     * request is settled here — the shop reads their key, an admin types it,
     * and Telga answers whether it is the right one. The key is compared and
     * discarded; it is never stored, logged, or echoed back.
     *
     * `ADMIN_VIEW_DEVICE` rather than a stronger permission: this reveals
     * nothing. A wrong guess learns only that the guess was wrong, which is
     * what a wrong sign-in already tells anybody.
     */
    allowed.has('ADMIN_VIEW_DEVICE') &&
      h(
        'details',
        { class: 'console__disclosure', 'data-testid': 'device-verify' },
        h('summary', {}, 'Check a device key'),
        h(
          'p',
          { class: 'console__hint' },
          'Telga stores only a scrambled copy of a device key and can never display one. ' +
            'Ask the shop to read theirs out and check it here. The Key column shows a short ' +
            'name for each key, so two devices can be told apart without anyone reading a secret.',
        ),
        h(
          'form',
          { method: 'post', action: '/devices/verify-key', 'data-testid': 'device-verify-form' },
          h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
          h(
            'div',
            { class: 'console__field' },
            h('label', { for: 'verifyDeviceId' }, 'Device'),
            h('input', {
              id: 'verifyDeviceId',
              name: 'deviceId',
              type: 'text',
              required: true,
              'data-testid': 'device-verify-id',
            }),
          ),
          h(
            'div',
            { class: 'console__field' },
            h('label', { for: 'verifyKey' }, 'Key the shop read out'),
            h('input', {
              id: 'verifyKey',
              name: 'deviceKey',
              type: 'password',
              required: true,
              autocomplete: 'off',
              'data-testid': 'device-verify-key',
            }),
          ),
          h(
            'button',
            { type: 'submit', class: 'console__button', 'data-testid': 'device-verify-submit' },
            'Check',
          ),
        ),
      ),

    rows.length === 0
      ? h('p', { 'data-testid': 'devices-empty' }, 'No devices registered.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'devices-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Device'),
              h('th', { scope: 'col' }, 'Merchant'),
              h('th', { scope: 'col' }, 'Type'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Enrolment'),
              h('th', { scope: 'col' }, 'Key'),
              h('th', { scope: 'col' }, 'Last seen'),
              h('th', { scope: 'col' }, ''),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `device-${row.id}`, 'data-status': row.status },
                h('td', {}, row.id),
                h('td', {}, row.merchantId),
                h('td', {}, row.deviceType),
                h('td', {}, h('span', { class: 'console__pill' }, row.status)),
                h('td', {}, row.enrollmentState ?? '—'),
                // The fingerprint, never the key. Monospaced because it is read
                // aloud and compared character by character.
                h(
                  'td',
                  { class: 'console__mono', 'data-testid': `device-key-fp-${row.id}` },
                  row.keyFingerprint ?? '—',
                ),
                h('td', {}, row.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never'),
                h(
                  'td',
                  {},
                  allowed.has('ADMIN_ISSUE_ENROLLMENT_TOKEN')
                    ? h(
                        'form',
                        {
                          method: 'post',
                          action: `/devices/${encodeURIComponent(row.id)}/enrollment-token`,
                          'data-testid': `device-token-form-${row.id}`,
                        },
                        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                        h(
                          'button',
                          { type: 'submit', class: 'console__button', 'data-testid': `device-token-${row.id}` },
                          'Issue code',
                        ),
                      )
                    : '',
                  /**
                   * Remote stop — and the way back.
                   *
                   * `CLAUDE.md` §18 lists *"remote stop of new sales without
                   * deleting history"* among the device controls a merchant
                   * platform must have. The **route existed and had no button**:
                   * `POST /devices/:id/stop` worked and was reachable only by
                   * typing the address, which is how a required control gets
                   * reported as missing.
                   *
                   * **Reinstate did not exist at all.** A stopped device was
                   * stopped for ever — the commonest real case being a machine
                   * reported lost and then found, which needed a whole new
                   * device record and a new activation code for no reason.
                   *
                   * Stopping asks first. It ends every session the device holds
                   * and revokes its enrolment, so a shop mid-sale stops mid-sale;
                   * an accidental click is a phone call and a fresh activation
                   * code.
                   */
                  allowed.has('ADMIN_REMOTE_STOP_SALES') && row.status === 'ACTIVE'
                    ? h(
                        'form',
                        {
                          method: 'post',
                          action: `/devices/${encodeURIComponent(row.id)}/stop`,
                          'data-testid': `device-stop-form-${row.id}`,
                        },
                        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                        h(
                          'button',
                          {
                            type: 'submit',
                            class: 'console__button',
                            'data-confirm':
                              'Stop this device? It will sign out immediately and need a new activation code to return.',
                            'data-testid': `device-stop-${row.id}`,
                          },
                          'Stop',
                        ),
                      )
                    : '',
                  allowed.has('ADMIN_REMOTE_STOP_SALES') && row.status !== 'ACTIVE'
                    ? h(
                        'form',
                        {
                          method: 'post',
                          action: `/devices/${encodeURIComponent(row.id)}/reinstate`,
                          'data-testid': `device-reinstate-form-${row.id}`,
                        },
                        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                        h(
                          'button',
                          { type: 'submit', class: 'console__button', 'data-testid': `device-reinstate-${row.id}` },
                          'Reinstate',
                        ),
                      )
                    : '',
                ),
              ),
            ),
          ),
        ),
  );
}

/**
 * The enrolment token, shown exactly once.
 *
 * Its own screen rather than a line in a table, because the whole point is
 * that an admin sees it, writes it down or reads it out, and never sees it
 * again. Burying it in a row invites somebody to assume they can come back.
 */
export function enrollmentTokenScreen(
  chrome: ConsoleChrome,
  issued: { deviceId: string; token: string; expiresAt: string; notice: string },
): El {
  return page(
    { ...chrome, section: 'devices' },
    'Activation code',
    h('p', { class: 'console__note' }, `Device ${issued.deviceId}`),
    h('p', { class: 'console__token', 'data-testid': 'enrollment-token' }, issued.token),
    h(
      'p',
      { class: 'console__error', 'data-testid': 'enrollment-notice' },
      issued.notice,
    ),
    h(
      'p',
      { class: 'console__note', 'data-testid': 'enrollment-expiry' },
      `Expires ${issued.expiresAt.slice(0, 16).replace('T', ' ')} UTC. Single use.`,
    ),
    h('p', {}, h('a', { href: '/devices', 'data-testid': 'enrollment-back' }, 'Back to devices')),
  );
}

// --- tenants ---------------------------------------------------------------

export interface TenantRow {
  readonly merchantId: string;
  readonly databaseName: string;
  readonly schemaVersion: string;
  readonly status: string;
  readonly lastBackupAt: string | null;
}

export function tenantsScreen(
  chrome: ConsoleChrome,
  rows: readonly TenantRow[],
  currentVersion: string,
): El {
  return page(
    { ...chrome, section: 'tenants' },
    'Tenant databases',
    h(
      'p',
      { class: 'console__note', 'data-testid': 'tenants-note' },
      `Each shop has its own database. Current schema version ${currentVersion}. ` +
        'A tenant on an older version is not safe to serve until it is migrated.',
    ),
    rows.length === 0
      ? h('p', { 'data-testid': 'tenants-empty' }, 'No tenant databases registered.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'tenants-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Merchant'),
              h('th', { scope: 'col' }, 'Database'),
              h('th', { scope: 'col' }, 'Schema'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Last backup'),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                {
                  'data-testid': `tenant-${row.merchantId}`,
                  'data-behind': row.schemaVersion === currentVersion ? 'false' : 'true',
                },
                h('td', {}, row.merchantId),
                h('td', {}, row.databaseName),
                h('td', {}, row.schemaVersion),
                h('td', {}, h('span', { class: 'console__pill' }, row.status)),
                // A shop never backed up is the loudest row on the page.
                h(
                  'td',
                  { class: row.lastBackupAt === null ? 'console__error' : undefined },
                  row.lastBackupAt?.slice(0, 16).replace('T', ' ') ?? 'never',
                ),
              ),
            ),
          ),
        ),
  );
}

// --- administrators --------------------------------------------------------

export interface AdminRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly department: string;
  readonly role: string;
  readonly status: string;
  readonly mfaEnrolled: boolean;
  readonly lastLoginAt: string | null;
}

export function adminsScreen(
  chrome: ConsoleChrome,
  rows: readonly AdminRow[],
  allowed: Allowed,
  error?: string,
): El {
  return page(
    { ...chrome, section: 'admins' },
    'Administrators',
    error === undefined
      ? ''
      : h('p', { class: 'console__error', role: 'alert', 'data-testid': 'admins-error' }, error),
    h(
      'table',
      { class: 'console__table', 'data-testid': 'admins-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Name'),
          h('th', { scope: 'col' }, 'Email'),
          h('th', { scope: 'col' }, 'Department'),
          h('th', { scope: 'col' }, 'Role'),
          h('th', { scope: 'col' }, 'Status'),
          h('th', { scope: 'col' }, 'MFA'),
          h('th', { scope: 'col' }, 'Last login'),
          ...(allowed.has('ADMIN_MANAGE_ADMINS') ? [h('th', { scope: 'col' }, 'Recovery')] : []),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            { 'data-testid': `admin-${row.id}`, 'data-status': row.status },
            h('td', {}, row.displayName),
            h('td', {}, row.email),
            h('td', {}, row.department),
            h('td', {}, row.role),
            h('td', {}, h('span', { class: 'console__pill' }, row.status)),
            h(
              'td',
              { 'data-testid': `admin-mfa-${row.id}` },
              row.mfaEnrolled ? 'enrolled' : 'not enrolled',
            ),
            h('td', {}, row.lastLoginAt?.slice(0, 16).replace('T', ' ') ?? 'never'),
            // The reset for a lost or replaced phone. It clears the second
            // factor so the admin can enrol a new one; it hands nobody a code.
            // Offered only to whoever may actually do it — the route refuses
            // everyone else regardless of what the page shows.
            ...(allowed.has('ADMIN_MANAGE_ADMINS')
              ? [
                  h(
                    'td',
                    {},
                    row.mfaEnrolled
                      ? h(
                          'form',
                          {
                            method: 'post',
                            action: `/admins/${encodeURIComponent(row.id)}/reset-mfa`,
                            'data-testid': `admin-reset-mfa-${row.id}`,
                          },
                          h('input', {
                            type: 'hidden',
                            name: 'csrfToken',
                            value: chrome.csrfToken ?? '',
                          }),
                          h(
                            'button',
                            {
                              type: 'submit',
                              class: 'console__button console__button--danger',
                              // Said plainly on the control, because the
                              // consequence lands on somebody else's account.
                              title: 'Clears their authenticator and signs them out everywhere',
                            },
                            'Reset authenticator',
                          ),
                        )
                      : h('span', { class: 'console__muted' }, 'nothing to reset'),
                  ),
                ]
              : []),
          ),
        ),
      ),
    ),
    // Only the Platform Owner holds ADMIN_MANAGE_ADMINS, so this form appears
    // for nobody else — and the route refuses everyone else regardless.
    allowed.has('ADMIN_MANAGE_ADMINS')
      ? h(
          'form',
          { method: 'post', action: '/admins', 'data-testid': 'admin-create-form' },
          h('h2', {}, 'Create an administrator'),
          h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
          field('Name', 'displayName', { required: true }),
          field('Email', 'email', { type: 'email', required: true }),
          h(
            'div',
            { class: 'console__field' },
            h('label', { for: 'department' }, 'Department'),
            h(
              'select',
              { id: 'department', name: 'department', 'data-testid': 'field-department' },
              ...['PLATFORM', 'TECHNICAL', 'SALES', 'SUPPORT', 'FINANCE', 'SECURITY'].map((d) =>
                h('option', { value: d }, d),
              ),
            ),
          ),
          h(
            'div',
            { class: 'console__field' },
            h('label', { for: 'role' }, 'Role'),
            h(
              'select',
              { id: 'role', name: 'role', 'data-testid': 'field-role' },
              ...[
                'OPERATIONS_ADMIN',
                'FINANCE_VERIFIER',
                'SUPPORT_AGENT',
                'AUDITOR',
                'SECURITY_ADMIN',
                'DEPARTMENT_ADMIN',
              ].map((r) => h('option', { value: r }, r)),
            ),
          ),
          field('Temporary password', 'password', { type: 'password', required: true }),
          h(
            'button',
            { type: 'submit', class: 'console__button', 'data-testid': 'admin-create' },
            'Create',
          ),
          h(
            'p',
            { class: 'console__note' },
            'Only the Platform Owner may create an administrator. The account starts PENDING and ' +
              'must enrol a second factor before it can do anything.',
          ),
        )
      : h(
          'p',
          { class: 'console__note', 'data-testid': 'admins-cannot-create' },
          'Only the Platform Owner may create an administrator.',
        ),
  );
}

// --- audit -----------------------------------------------------------------

export interface AuditRow {
  readonly at: string;
  readonly actor: string;
  readonly event: string;
  readonly entity: string;
  readonly merchantId: string | null;
}

export function auditScreen(chrome: ConsoleChrome, rows: readonly AuditRow[]): El {
  return page(
    { ...chrome, section: 'audit' },
    'Audit',
    rows.length === 0
      ? h('p', { 'data-testid': 'audit-empty' }, 'Nothing recorded yet.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'audit-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'When'),
              h('th', { scope: 'col' }, 'Actor'),
              h('th', { scope: 'col' }, 'Event'),
              h('th', { scope: 'col' }, 'Entity'),
              h('th', { scope: 'col' }, 'Merchant'),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row, i) =>
              h(
                'tr',
                { 'data-testid': `audit-row-${i}` },
                h('td', {}, row.at.slice(0, 19).replace('T', ' ')),
                h('td', {}, row.actor),
                h('td', {}, row.event),
                h('td', {}, row.entity),
                h('td', {}, row.merchantId ?? '—'),
              ),
            ),
          ),
        ),
  );
}

/** A refusal an admin can act on, without saying anything an attacker could use. */
export function deniedScreen(chrome: ConsoleChrome, reason: string): El {
  return page(
    chrome,
    'Not permitted',
    h('p', { class: 'console__error', role: 'alert', 'data-testid': 'denied-reason' }, reason),
    h('p', {}, h('a', { href: '/', 'data-testid': 'denied-home' }, 'Back to the dashboard')),
  );
}
