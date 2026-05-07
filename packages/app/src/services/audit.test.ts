import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { ApiError } from '@backup-saas/shared';
import { createDb, createSqlClient, type SqlClient } from '../db/client';
import { auditEvents, plans, users, workspaceMembers, workspaces } from '../db/schema';
import { listAuditEvents, sanitizeAuditMetadata, toSafeAuditEvent, writeAuditEvent } from './audit';

Bun.env.DATABASE_URL = 'postgres://backup_saas:backup_saas@localhost:5433/backup_saas';

describe('audit metadata sanitization', () => {
  test('redacts sensitive top-level metadata keys', () => {
    const sanitized = sanitizeAuditMetadata({
      password: 'secret-password',
      client_secret: 'oauth-secret',
      accessToken: 'oauth-token',
      encryption_key: 'key-material',
      credentialFingerprint: 'fingerprint',
      connectionString: 'postgres://user:pass@host/db',
    });

    expect(sanitized).toEqual({
      password: '[REDACTED]',
      client_secret: '[REDACTED]',
      accessToken: '[REDACTED]',
      encryption_key: '[REDACTED]',
      credentialFingerprint: '[REDACTED]',
      connectionString: '[REDACTED]',
    });
  });

  test('keeps safe metadata visible', () => {
    const sanitized = sanitizeAuditMetadata({
      status: 'succeeded',
      database_source_id: 'source-123',
      attempt_count: 1,
      manual: true,
      note: null,
    });

    expect(sanitized).toEqual({
      status: 'succeeded',
      database_source_id: 'source-123',
      attempt_count: 1,
      manual: true,
      note: null,
    });
  });

  test('redacts sensitive nested metadata keys recursively', () => {
    const sanitized = sanitizeAuditMetadata({
      details: { password: 'nested-secret', host: 'db.example.com' },
      attempts: [{ accessToken: 'nested-token', status: 'failed' }],
      nested_token: { value: 'fully-redacted' },
    });

    expect(sanitized).toEqual({
      details: { password: '[REDACTED]', host: 'db.example.com' },
      attempts: [{ accessToken: '[REDACTED]', status: 'failed' }],
      nested_token: '[REDACTED]',
    });
  });
});

describe('audit event integration', () => {
  let sql: SqlClient;
  const ids: string[] = [];

  beforeAll(() => {
    sql = createSqlClient();
  });

  afterAll(async () => {
    for (const id of ids.reverse()) {
      await sql`delete from audit_events where workspace_id = ${id} or resource_id = ${id}`;
      await sql`delete from workspace_members where workspace_id = ${id} or user_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await sql.end();
  });

  async function setupFixture() {
    const db = createDb(sql);
    const [plan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
    const [user] = await db.insert(users).values({ email: `audit-${crypto.randomUUID()}@example.com`, name: 'Audit User' }).returning();
    const [nonMember] = await db.insert(users).values({ email: `audit-nonmember-${crypto.randomUUID()}@example.com`, name: 'Audit Nonmember' }).returning();
    const [workspace] = await db.insert(workspaces).values({ name: 'Audit Test', slug: `audit-${crypto.randomUUID()}`, timezone: 'Asia/Jakarta', planId: plan!.id, storageStatus: 'ready' }).returning();
    ids.push(user!.id, nonMember!.id, workspace!.id);
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });
    return { db, user: user!, nonMember: nonMember!, workspace: workspace! };
  }

  test('writeAuditEvent stores recursively redacted metadata and safe event shape', async () => {
    const { db, user, workspace } = await setupFixture();
    const resourceId = crypto.randomUUID();
    ids.push(resourceId);

    await writeAuditEvent(db, {
      workspaceId: workspace.id,
      eventType: 'security.test',
      actor: { type: 'user', userId: user.id },
      resourceType: 'backup',
      resourceId,
      metadata: {
        status: 'succeeded',
        password: 'top-level-secret',
        details: { accessToken: 'nested-token', host: 'db.example.com' },
      },
    });

    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, resourceId)).limit(1);
    expect(row).toBeDefined();
    const safe = toSafeAuditEvent(row!);

    expect(safe.metadata).toEqual({
      status: 'succeeded',
      password: '[REDACTED]',
      details: { accessToken: '[REDACTED]', host: 'db.example.com' },
    });
    expect(JSON.stringify(safe)).not.toContain('top-level-secret');
    expect(JSON.stringify(safe)).not.toContain('nested-token');
  });

  test('listAuditEvents requires Workspace membership', async () => {
    const { db, user, nonMember, workspace } = await setupFixture();
    await writeAuditEvent(db, {
      workspaceId: workspace.id,
      eventType: 'security.test',
      actor: { type: 'user', userId: user.id },
      resourceType: 'workspace',
      resourceId: workspace.id,
      metadata: {},
    });

    const visible = await listAuditEvents(db, workspace.id, user.id);
    await expect(listAuditEvents(db, workspace.id, nonMember.id)).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' } satisfies Partial<ApiError>);

    expect(visible.length).toBeGreaterThan(0);
  });
});
