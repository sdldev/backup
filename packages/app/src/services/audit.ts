import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { auditEvents } from '../db';
import { requireWorkspaceMembership } from './workspace-access';

type AuditMetadataValue = string | number | boolean | null | AuditMetadataValue[] | { [key: string]: AuditMetadataValue };

type AuditEventInput = {
  workspaceId: string | null;
  eventType: string;
  actor: { type: 'user' | 'system' | 'platform_admin'; userId?: string | null };
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, AuditMetadataValue>;
};

const SENSITIVE_KEY_PATTERN = /password|secret|token|key|credential|connection/i;

export async function writeAuditEvent(db: Db, input: AuditEventInput) {
  const metadata = sanitizeAuditMetadata(input.metadata ?? {});

  await db.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    eventType: input.eventType,
    actorType: input.actor.type,
    actorUserId: input.actor.userId ?? null,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    metadata: JSON.stringify(metadata),
  });
}

export async function listAuditEvents(db: Db, workspaceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(50);
}

export function toSafeAuditEvent(event: typeof auditEvents.$inferSelect) {
  return {
    id: event.id,
    workspace_id: event.workspaceId,
    event_type: event.eventType,
    actor: {
      type: event.actorType,
      user_id: event.actorUserId,
    },
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    metadata: JSON.parse(event.metadata) as Record<string, unknown>,
    created_at: event.createdAt.toISOString(),
  };
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (value && typeof value === 'object') return sanitizeAuditMetadata(value as Record<string, unknown>);
  return value;
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeAuditValue(value)]),
  );
}
