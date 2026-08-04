import type { Database } from '../client';
import { auditEvents } from '../schema';

export type AuditExecutor = Pick<Database, 'insert'>;

export interface AppendAuditEventInput {
  tenantId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  source: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
  occurredAt?: string;
  recordedAt?: string;
  authProvider?: string | null;
  sessionId?: string | null;
}

function jsonValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export async function appendAuditEvent(
  executor: AuditExecutor,
  input: AppendAuditEventInput,
) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const recordedAt = input.recordedAt ?? occurredAt;
  const row = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    occurredAt,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    source: input.source,
    reason: input.reason ?? null,
    beforeJson: jsonValue(input.before),
    afterJson: jsonValue(input.after),
    correlationId: input.correlationId ?? crypto.randomUUID(),
    authProvider: input.authProvider ?? null,
    sessionId: input.sessionId ?? null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };

  await executor.insert(auditEvents).values(row);
  return Object.freeze({ ...row });
}
