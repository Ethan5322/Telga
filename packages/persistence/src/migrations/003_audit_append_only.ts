import type { Migration } from './index';

/**
 * Append-only enforcement for `audit_events`.
 *
 * An audit trail that can be edited is not an audit trail. Audit tampering is a
 * named security test case in `docs/obsidian/09 Engineering/Testing Strategy.md`;
 * this is the control that makes the test pass for a reason rather than by
 * convention.
 */
export const m003AuditAppendOnly: Migration = {
  version: '003',
  name: 'audit_append_only',
  sql: `
CREATE TRIGGER audit_events_forbid_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is forbidden.');
END;

CREATE TRIGGER audit_events_forbid_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is forbidden.');
END;
`,
};
