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
}

export function applicationsScreen(
  chrome: ConsoleChrome,
  rows: readonly ApplicationRow[],
  allowed: Allowed,
): El {
  return page(
    { ...chrome, section: 'applications' },
    'Applications',
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
                h('td', {}, row.locality),
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

export interface ApplicationDetail extends ApplicationRow {
  readonly tradingName: string | null;
  readonly ownerName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly address: string;
  readonly decisionReason: string | null;
}

export function applicationDetailScreen(
  chrome: ConsoleChrome,
  application: ApplicationDetail,
  allowed: Allowed,
  error?: string,
): El {
  const row = (label: string, value: string, id: string): El =>
    h('tr', {}, h('th', { scope: 'row' }, label), h('td', { 'data-testid': id }, value));

  const decidable = application.status === 'UNDER_REVIEW';

  return page(
    { ...chrome, section: 'applications' },
    `Application ${application.reference}`,
    error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'application-error' }, error),
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
}

export function merchantsScreen(chrome: ConsoleChrome, rows: readonly MerchantRow[]): El {
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
              h('th', { scope: 'col' }, 'Since'),
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
                h('td', {}, row.createdAt.slice(0, 10)),
              ),
            ),
          ),
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
}

export function devicesScreen(
  chrome: ConsoleChrome,
  rows: readonly DeviceRow[],
  allowed: Allowed,
): El {
  return page(
    { ...chrome, section: 'devices' },
    'Devices',
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
