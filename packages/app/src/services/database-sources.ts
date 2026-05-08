import { and, asc, eq, isNull } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import type { Db } from '../db';
import { databaseSources, projects } from '../db';
import { writeAuditEvent } from './audit';
import { testConnection } from './database-engine-adapters';
import { assertCanCreateDatabaseSource } from './plan-limits';
import { encryptSecret, fingerprintSecret, maskSecret } from './secret-vault';
import { requireWorkspaceMembership } from './workspace-access';

type CreateDatabaseSourceInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  engine: 'mysql' | 'postgresql';
  displayName: string;
  technicalDatabaseName: string;
  host: string;
  port: number;
  username: string;
  password?: string | undefined;
  sslMode?: string | undefined;
  retentionDays: number;
};

export async function listDatabaseSourcesForProject(db: Db, workspaceId: string, projectId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);
  await requireProjectInWorkspace(db, workspaceId, projectId);

  return db
    .select()
    .from(databaseSources)
    .where(
      and(
        eq(databaseSources.workspaceId, workspaceId),
        eq(databaseSources.projectId, projectId),
        isNull(databaseSources.softDeletedAt),
      ),
    )
    .orderBy(asc(databaseSources.displayName));
}

export async function setDatabaseSourceState(
  db: Db,
  workspaceId: string,
  projectId: string,
  sourceId: string,
  userId: string,
  state: 'enabled' | 'disabled',
) {
  await requireWorkspaceMembership(db, workspaceId, userId);

  const [source] = await db
    .select()
    .from(databaseSources)
    .where(
      and(
        eq(databaseSources.id, sourceId),
        eq(databaseSources.workspaceId, workspaceId),
        eq(databaseSources.projectId, projectId),
        isNull(databaseSources.softDeletedAt),
      ),
    )
    .limit(1);

  if (!source) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Database Source not found');
  if (state === 'enabled' && source.lastConnectionTestStatus !== 'succeeded') {
    throw new ApiError(422, 'SOURCE_REQUIRES_SUCCESSFUL_TEST', 'Database Source requires a successful connection test before enabling');
  }

  const [updated] = await db
    .update(databaseSources)
    .set({ state, updatedAt: new Date() })
    .where(eq(databaseSources.id, source.id))
    .returning();

  return updated ?? source;
}

export async function testSavedDatabaseSource(db: Db, workspaceId: string, projectId: string, sourceId: string, userId: string) {
  await requireWorkspaceMembership(db, workspaceId, userId);

  const [source] = await db
    .select()
    .from(databaseSources)
    .where(
      and(
        eq(databaseSources.id, sourceId),
        eq(databaseSources.workspaceId, workspaceId),
        eq(databaseSources.projectId, projectId),
        isNull(databaseSources.softDeletedAt),
      ),
    )
    .limit(1);

  if (!source) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Database Source not found');

  const result = await testConnection({
    engine: source.engine,
    host: source.host,
    port: source.port,
    database: source.technicalDatabaseName,
    username: source.username,
    sslMode: source.sslMode,
  });

  const [updated] = await db
    .update(databaseSources)
    .set({
      lastConnectionTestAt: new Date(),
      lastConnectionTestStatus: result.ok ? 'succeeded' : 'failed',
      health: result.ok ? 'warning' : 'failing',
      updatedAt: new Date(),
    })
    .where(eq(databaseSources.id, source.id))
    .returning();

  return { source: updated ?? source, result };
}

export async function createDatabaseSource(db: Db, input: CreateDatabaseSourceInput) {
  await requireWorkspaceMembership(db, input.workspaceId, input.userId);
  await requireProjectInWorkspace(db, input.workspaceId, input.projectId);
  await assertCanCreateDatabaseSource(db, input.workspaceId, input.retentionDays);

  try {
    const [source] = await db
      .insert(databaseSources)
      .values({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        engine: input.engine,
        displayName: input.displayName.trim(),
        technicalDatabaseName: input.technicalDatabaseName.trim(),
        host: input.host.trim(),
        port: input.port,
        username: input.username.trim(),
        encryptedPassword: input.password ? await encryptSecret(input.password) : null,
        credentialFingerprint: input.password ? await fingerprintSecret(input.password) : null,
        sslMode: input.sslMode ?? 'require',
        state: 'disabled',
        health: 'unknown',
        retentionDays: input.retentionDays,
        createdByUserId: input.userId,
      })
      .returning();

    if (!source) throw new ApiError(500, 'SOURCE_CREATE_FAILED', 'Database Source could not be created');

    await writeAuditEvent(db, {
      workspaceId: input.workspaceId,
      eventType: 'database_source.created',
      actor: { type: 'user', userId: input.userId },
      resourceType: 'database_source',
      resourceId: source.id,
      metadata: { engine: source.engine, project_id: source.projectId },
    });

    if (input.password) {
      await writeAuditEvent(db, {
        workspaceId: input.workspaceId,
        eventType: 'database_credential.created',
        actor: { type: 'user', userId: input.userId },
        resourceType: 'database_source',
        resourceId: source.id,
        metadata: { credential: 'saved' },
      });
    }

    return source;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('database_sources_active_display_name_per_project_uidx')) {
      throw new ApiError(409, 'SOURCE_DISPLAY_NAME_TAKEN', 'Database Source display name is already used in this Project');
    }
    throw error;
  }
}

export function toSafeDatabaseSource(source: typeof databaseSources.$inferSelect) {
  return {
    id: source.id,
    workspace_id: source.workspaceId,
    project_id: source.projectId,
    engine: source.engine,
    display_name: source.displayName,
    technical_database_name: source.technicalDatabaseName,
    host: source.host,
    port: source.port,
    username: source.username,
    credential_mask: maskSecret(source.credentialFingerprint),
    has_saved_credential: Boolean(source.encryptedPassword),
    ssl_mode: source.sslMode,
    state: source.state,
    health: source.health,
    retention_days: source.retentionDays,
    last_connection_test_at: source.lastConnectionTestAt?.toISOString() ?? null,
    last_connection_test_status: source.lastConnectionTestStatus,
    last_successful_backup_at: source.lastSuccessfulBackupAt?.toISOString() ?? null,
    created_at: source.createdAt.toISOString(),
    updated_at: source.updatedAt.toISOString(),
  };
}

async function requireProjectInWorkspace(db: Db, workspaceId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.softDeletedAt)))
    .limit(1);

  if (!project) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Project not found');
  return project;
}
