/**
 * Audit events.
 *
 * Append-only in the database (migration 003) as well as here. No update, no
 * delete, no exceptions.
 */

import type { MerchantId } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { AuditInput } from '../driver/types';
import type { AuditEventRow } from '../schema/types';
import { serializeMetadata } from '../privacy';

export function saveAuditEvent(db: Db, input: AuditInput): AuditEventRow {
  const { event } = input;

  db.prepare(
    `INSERT INTO audit_events (
       id, actor_type, actor_id, event_type, entity_type, entity_id,
       merchant_id, correlation_id, metadata, created_at)
     VALUES (@id, @actorType, @actorId, @eventType, @entityType, @entityId,
       @merchantId, @correlationId, @metadata, @createdAt)`,
  ).run({
    id: event.id,
    actorType: event.actor.role,
    actorId: String(event.actor.userId),
    eventType: event.action,
    entityType: input.entityType,
    entityId: input.entityId ?? event.transactionId ?? null,
    merchantId: event.merchantId,
    correlationId: input.correlationId,
    metadata: serializeMetadata(input.metadata),
    createdAt: event.at,
  });

  const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(event.id) as
    | AuditEventRow
    | undefined;
  if (!row) throw new Error(`Audit event ${event.id} was not persisted`);
  return row;
}

export function readAuditEvents(db: Db, merchantId?: MerchantId): readonly AuditEventRow[] {
  if (merchantId === undefined) {
    return db.prepare('SELECT * FROM audit_events ORDER BY created_at, id').all() as AuditEventRow[];
  }
  return db
    .prepare('SELECT * FROM audit_events WHERE merchant_id = ? ORDER BY created_at, id')
    .all(merchantId) as AuditEventRow[];
}

export function readAuditEventsByCorrelation(db: Db, correlationId: string): readonly AuditEventRow[] {
  return db
    .prepare('SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY created_at, id')
    .all(correlationId) as AuditEventRow[];
}
