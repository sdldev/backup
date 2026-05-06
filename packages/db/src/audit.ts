import { createHash, randomUUID } from "node:crypto";
import type { AuditActorType, AuditEvent, AuditLogEntry, AuditResult, AuditTargetType } from "@mba/shared";
import { createSqlClient, getDatabaseUrl } from "./testing";

type SqlClient = ReturnType<typeof createSqlClient>;

export type AuditContext = {
  actorType: AuditActorType;
  actorUserId: string | null;
  effectiveActorUserId: string | null;
  systemAdminId?: string | null;
  impersonationSessionId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  impersonationReason?: string | null;
};

export type AppendAuditLogInput = {
  workspaceId: string | null;
  eventType: AuditEvent;
  targetType: AuditTargetType;
  targetId: string;
  result: AuditResult;
  internalErrorRef?: string | null;
  metadata?: Record<string, unknown>;
  context: AuditContext;
};

type AuditLogRow = {
  id: string;
  eventType: AuditEvent;
  actorType: AuditActorType;
  actorUserId: string | null;
  effectiveActorUserId: string | null;
  workspaceId: string | null;
  targetType: AuditTargetType;
  targetId: string;
  requestId: string | null;
  sessionIdHash: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  impersonationReason: string | null;
  result: AuditResult;
  internalErrorRef: string | null;
  createdAt: Date;
};

function hashSessionId(sessionId: string | null | undefined): string | null {
  return sessionId ? createHash("sha256").update(sessionId).digest("hex") : null;
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const blockedKey = /(password|secret|token|credential|decrypted|stdout|stderr|dump)/i;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !blockedKey.test(key)));
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    eventType: row.eventType,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    effectiveActorUserId: row.effectiveActorUserId,
    workspaceId: row.workspaceId,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    sessionIdHash: row.sessionIdHash,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    impersonationReason: row.impersonationReason,
    result: row.result,
    internalErrorRef: row.internalErrorRef,
    createdAt: row.createdAt.toISOString()
  };
}

export class AuditLogService {
  constructor(private readonly databaseUrl = getDatabaseUrl()) {}

  async append(input: AppendAuditLogInput): Promise<AuditLogEntry> {
    const client = createSqlClient(this.databaseUrl);
    try {
      const [row] = await appendAuditLogWithClient(client, input);
      return toEntry(row);
    } finally {
      await client.end();
    }
  }

  async listWorkspace(workspaceId: string): Promise<AuditLogEntry[]> {
    const client = createSqlClient(this.databaseUrl);
    try {
      const rows = await client<AuditLogRow[]>`
        select id,
          event_type as "eventType",
          actor_type::text as "actorType",
          actor_user_id as "actorUserId",
          effective_actor_user_id as "effectiveActorUserId",
          workspace_id as "workspaceId",
          target_type as "targetType",
          target_id as "targetId",
          request_id as "requestId",
          session_id_hash as "sessionIdHash",
          ip_address as "ipAddress",
          user_agent as "userAgent",
          impersonation_reason as "impersonationReason",
          result::text as result,
          internal_error_ref as "internalErrorRef",
          created_at as "createdAt"
        from audit_logs
        where workspace_id = ${workspaceId}
        order by created_at desc, id desc
      `;

      return rows.map(toEntry);
    } finally {
      await client.end();
    }
  }

  async update(): Promise<never> {
    throw new Error("audit_logs_append_only: update forbidden");
  }

  async delete(): Promise<never> {
    throw new Error("audit_logs_append_only: delete forbidden");
  }
}

export async function appendAuditLogWithClient(client: SqlClient, input: AppendAuditLogInput): Promise<[AuditLogRow]> {
  const [row] = await client<AuditLogRow[]>`
    insert into audit_logs (
      workspace_id,
      actor_type,
      actor_user_id,
      effective_actor_user_id,
      system_admin_id,
      impersonation_session_id,
      session_id_hash,
      request_id,
      event_type,
      target_type,
      target_id,
      ip_address,
      user_agent,
      impersonation_reason,
      result,
      internal_error_ref,
      metadata
    ) values (
      ${input.workspaceId},
      ${input.context.actorType},
      ${input.context.actorUserId},
      ${input.context.effectiveActorUserId},
      ${input.context.systemAdminId ?? null},
      ${input.context.impersonationSessionId ?? null},
      ${hashSessionId(input.context.sessionId)},
      ${input.context.requestId ?? randomUUID()},
      ${input.eventType},
      ${input.targetType},
      ${input.targetId},
      ${input.context.ipAddress ?? null},
      ${input.context.userAgent ?? null},
      ${input.context.impersonationReason ?? null},
      ${input.result},
      ${input.internalErrorRef ?? null},
      ${JSON.stringify(sanitizeMetadata(input.metadata))}::jsonb
    )
    returning id,
      event_type as "eventType",
      actor_type::text as "actorType",
      actor_user_id as "actorUserId",
      effective_actor_user_id as "effectiveActorUserId",
      workspace_id as "workspaceId",
      target_type as "targetType",
      target_id as "targetId",
      request_id as "requestId",
      session_id_hash as "sessionIdHash",
      ip_address as "ipAddress",
      user_agent as "userAgent",
      impersonation_reason as "impersonationReason",
      result::text as result,
      internal_error_ref as "internalErrorRef",
      created_at as "createdAt"
  `;

  if (!row) {
    throw new Error("audit_logs_append_failed");
  }

  return [row];
}
