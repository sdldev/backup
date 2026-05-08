import { and, eq } from 'drizzle-orm';
import { createDb } from './client';
import {
  backupJobs,
  backupStorageConfigs,
  backups,
  databaseSources,
  plans,
  projects,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from './schema';
import { encryptBackupArtifact } from '../services/backup-artifact-crypto';
import { createObjectStorageProvider } from '../services/object-storage';

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function must<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

const db = createDb();
const token = Bun.env.DEV_SESSION_TOKEN ?? 'dev-session-token';
const inviteeToken = Bun.env.DEV_INVITEE_SESSION_TOKEN ?? 'dev-invitee-session-token';
const tokenHash = await hashSessionToken(token);
const inviteeTokenHash = await hashSessionToken(inviteeToken);

const [basicPlan] = await db.select().from(plans).where(eq(plans.slug, 'basic')).limit(1);
if (!basicPlan) throw new Error('Run db:seed first; Basic plan missing');

const [createdUser] = await db
  .insert(users)
  .values({ email: 'dev@example.com', name: 'Dev User' })
  .onConflictDoUpdate({ target: users.email, set: { name: 'Dev User', updatedAt: new Date() } })
  .returning();
const user = must(createdUser, 'user');

const [createdInviteeUser] = await db
  .insert(users)
  .values({ email: 'dev-invitee@example.com', name: 'Dev Invitee' })
  .onConflictDoUpdate({ target: users.email, set: { name: 'Dev Invitee', updatedAt: new Date() } })
  .returning();
const inviteeUser = must(createdInviteeUser, 'invitee user');

const [createdWorkspace] = await db
  .insert(workspaces)
  .values({ name: 'Dev Workspace', slug: 'dev-workspace', timezone: 'Asia/Jakarta', planId: basicPlan.id, storageStatus: 'ready' })
  .onConflictDoUpdate({ target: workspaces.slug, set: { storageStatus: 'ready', updatedAt: new Date() } })
  .returning();
const workspace = must(createdWorkspace, 'workspace');

await db
  .insert(workspaceMembers)
  .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
  .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: 'owner', updatedAt: new Date() } });

await db
  .insert(sessions)
  .values({ userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), userAgent: 'dev-seed' })
  .onConflictDoUpdate({ target: sessions.tokenHash, set: { invalidatedAt: null, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });

await db
  .insert(sessions)
  .values({ userId: inviteeUser.id, tokenHash: inviteeTokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), userAgent: 'dev-seed-invitee' })
  .onConflictDoUpdate({ target: sessions.tokenHash, set: { invalidatedAt: null, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });

const [existingProject] = await db
  .select()
  .from(projects)
  .where(and(eq(projects.workspaceId, workspace.id), eq(projects.name, 'Demo Project')))
  .limit(1);
const project = existingProject ?? must(
  (
    await db
      .insert(projects)
      .values({ workspaceId: workspace.id, name: 'Demo Project', websiteUrl: 'https://example.com', createdByUserId: user.id })
      .returning()
  )[0],
  'project',
);

const [existingSource] = await db
  .select()
  .from(databaseSources)
  .where(and(eq(databaseSources.projectId, project.id), eq(databaseSources.displayName, 'Demo MySQL')))
  .limit(1);
const source = existingSource ?? must(
  (
    await db
      .insert(databaseSources)
      .values({
    workspaceId: workspace.id,
    projectId: project.id,
    engine: 'mysql',
    displayName: 'Demo MySQL',
    technicalDatabaseName: 'demo_db',
    host: 'mysql.example.internal',
    port: 3306,
    username: 'demo_user',
    state: 'enabled',
    health: 'healthy',
    retentionDays: 7,
    lastConnectionTestStatus: 'succeeded',
    lastConnectionTestAt: new Date(),
    createdByUserId: user.id,
      })
      .returning()
  )[0],
  'source',
);

const [createdStorageConfig] = await db
  .insert(backupStorageConfigs)
  .values({
    workspaceId: workspace.id,
    provider: 'local_disk',
    mode: 'platform_managed',
    displayName: 'Local dev storage',
    storagePrefix: `workspace/${workspace.id}`,
    status: 'active',
    isCurrent: true,
    createdByUserId: user.id,
    activatedAt: new Date(),
  })
  .returning();
const storageConfig = must(createdStorageConfig, 'storage config');

const [createdJob] = await db
  .insert(backupJobs)
  .values({ workspaceId: workspace.id, projectId: project.id, databaseSourceId: source.id, trigger: 'manual', requestedByUserId: user.id, status: 'succeeded', stage: 'succeeded', startedAt: new Date(), finishedAt: new Date() })
  .returning();
const job = must(createdJob, 'backup job');

const objectKey = `workspace/${workspace.id}/dev-backup.sql.gz`;
const plaintext = new TextEncoder().encode('-- demo backup scaffold\nselect 1;\n');
const body = await encryptBackupArtifact(plaintext);
await createObjectStorageProvider().putObject({ key: objectKey, body: new Response(body).body!, contentLength: body.byteLength });

const existingBackup = await db
  .select()
  .from(backups)
  .where(and(eq(backups.workspaceId, workspace.id), eq(backups.objectKey, objectKey)))
  .limit(1);

if (existingBackup.length === 0) {
  await db.insert(backups).values({
    workspaceId: workspace.id,
    projectId: project.id,
    databaseSourceId: source.id,
    backupJobId: job.id,
    storageConfigId: storageConfig.id,
    status: 'succeeded',
    format: 'mysql_sql_gzip',
    objectKey,
    downloadFilename: 'demo-project-demo-mysql-20260507T000000Z.sql.gz',
    encryptedSizeBytes: body.byteLength,
    originalSizeBytes: plaintext.byteLength,
    checksumSha256: null,
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
}

console.info('dev seed complete');
console.info(`Owner cookie: backup_saas_session=${token}`);
console.info(`Invitee cookie: backup_saas_session=${inviteeToken}`);
console.info('Owner open: http://localhost:4321/workspace/dev-workspace');
console.info('Invitee email: dev-invitee@example.com');
process.exit(0);
