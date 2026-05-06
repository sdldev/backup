import { createHash } from "node:crypto";
import { createSqlClient } from "../../packages/db/src/testing";
import { encryptBackupStream, loadAppMasterKeyFromEnv, unwrapWorkspaceKey, wrapBackupDataKey, wrapWorkspaceKey } from "../../packages/security/src/index";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../scripts/db/_test-db";
import { createFakeDumpProcess } from "./fake-dump";
import { resolveFakeOAuthIdentity } from "./fake-oauth";
import { FakeS3Storage } from "./fake-storage";

export type SeededHarness = Awaited<ReturnType<typeof seedHarnessFixtures>>;

function hashValue(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const appMasterKey = loadAppMasterKeyFromEnv({ APP_MASTER_KEY_V1: Buffer.alloc(32, 7).toString("base64url") });
const workspaceKeyA = new Uint8Array(32).fill(11);
const workspaceKeyB = new Uint8Array(32).fill(12);

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    chunks.push(read.value);
    total += read.value.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function seedHarnessFixtures() {
  const databaseUrl = resolveDatabaseUrl();
  await ensureFreshTestSchema(databaseUrl);

  const client = createSqlClient(databaseUrl);

  try {
    const [basicPlan] = await client<{ id: string }[]>`select id from plans where slug = 'basic' limit 1`;
    const agencyA = resolveFakeOAuthIdentity("google", "agency-a@example.com");
    const agencyB = resolveFakeOAuthIdentity("github", "agency-b@example.com");

    const [userA] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${agencyA.email}, ${agencyA.name})
      returning id
    `;
    const [userB] = await client<{ id: string }[]>`
      insert into users (email, name)
      values (${agencyB.email}, ${agencyB.name})
      returning id
    `;

    await client`
      insert into oauth_accounts (user_id, provider, provider_account_id, provider_email)
      values
        (${userA.id}, ${agencyA.provider}, ${agencyA.providerAccountId}, ${agencyA.email}),
        (${userB.id}, ${agencyB.provider}, ${agencyB.providerAccountId}, ${agencyB.email})
    `;

    const [workspaceA] = await client<{ id: string; slug: string }[]>`
      insert into workspaces (name, slug, timezone, plan_id, storage_status, onboarding_step)
      values ('Workspace Agency A', 'ws_agency_a', 'UTC', ${basicPlan.id}, 'ready', 'complete')
      returning id, slug
    `;
    const [workspaceB] = await client<{ id: string; slug: string }[]>`
      insert into workspaces (name, slug, timezone, plan_id, storage_status, onboarding_step)
      values ('Workspace Agency B', 'ws_agency_b', 'UTC', ${basicPlan.id}, 'ready', 'complete')
      returning id, slug
    `;
    const wrappedWorkspaceKeyA = await wrapWorkspaceKey({ workspaceId: workspaceA.id, workspaceKey: workspaceKeyA, appMasterKey });
    const wrappedWorkspaceKeyB = await wrapWorkspaceKey({ workspaceId: workspaceB.id, workspaceKey: workspaceKeyB, appMasterKey });

    await client`
      insert into workspace_members (workspace_id, user_id, role)
      values
        (${workspaceA.id}, ${userA.id}, 'owner'),
        (${workspaceB.id}, ${userB.id}, 'owner')
    `;

    const [adminA] = await client<{ id: string }[]>`
      insert into users (email, name)
      values ('agency-a-admin@example.com', 'Agency A Admin')
      returning id
    `;
    const [memberA] = await client<{ id: string }[]>`
      insert into users (email, name)
      values ('agency-a-member@example.com', 'Agency A Member')
      returning id
    `;

    await client`
      insert into workspace_members (workspace_id, user_id, role)
      values
        (${workspaceA.id}, ${adminA.id}, 'admin'),
        (${workspaceA.id}, ${memberA.id}, 'member')
    `;

    const [storageA] = await client<{ id: string; storage_prefix: string }[]>`
      insert into backup_storage_configs (
        workspace_id, provider, mode, display_name, storage_prefix, credential_fingerprint, status, is_current, activated_at, created_by_user_id
      ) values (
        ${workspaceA.id}, 'minio', 'platform_managed', 'Fake Storage A', 'opaque/o1', 'fp_o1', 'active', true, now(), ${userA.id}
      ) returning id, storage_prefix
    `;
    const [storageB] = await client<{ id: string; storage_prefix: string }[]>`
      insert into backup_storage_configs (
        workspace_id, provider, mode, display_name, storage_prefix, credential_fingerprint, status, is_current, activated_at, created_by_user_id
      ) values (
        ${workspaceB.id}, 'minio', 'platform_managed', 'Fake Storage B', 'opaque/o2', 'fp_o2', 'active', true, now(), ${userB.id}
      ) returning id, storage_prefix
    `;

    const [projectA] = await client<{ id: string }[]>`
      insert into projects (workspace_id, name, website_url, created_by_user_id)
      values (${workspaceA.id}, 'Agency A Main Project', 'https://agency-a.example.com', ${userA.id})
      returning id
    `;
    const [projectB] = await client<{ id: string }[]>`
      insert into projects (workspace_id, name, website_url, created_by_user_id)
      values (${workspaceB.id}, 'Agency B Main Project', 'https://agency-b.example.com', ${userB.id})
      returning id
    `;

    const [sourcePg] = await client<{ id: string; display_name: string }[]>`
      insert into database_sources (
        workspace_id, project_id, engine, display_name, technical_database_name, host, port, username, encrypted_password, credential_fingerprint,
        ssl_mode, state, health, retention_days, schedule_frequency_per_day, created_by_user_id, last_connection_test_at, last_connection_test_status
      ) values (
        ${workspaceA.id}, ${projectA.id}, 'postgresql', 'src_pg_prod_1', 'agency_a_prod', 'db.internal', 5432, 'postgres', 'enc_pw_pg', 'cred_pg',
        'require', 'enabled', 'healthy', 14, 1, ${userA.id}, now(), 'succeeded'
      ) returning id, display_name
    `;
    const [sourceMysql] = await client<{ id: string; display_name: string }[]>`
      insert into database_sources (
        workspace_id, project_id, engine, display_name, technical_database_name, host, port, username, encrypted_password, credential_fingerprint,
        ssl_mode, state, health, retention_days, schedule_frequency_per_day, created_by_user_id, last_connection_test_at, last_connection_test_status
      ) values (
        ${workspaceB.id}, ${projectB.id}, 'mysql', 'src_mysql_prod_1', 'agency_b_prod', 'mysql.internal', 3306, 'root', 'enc_pw_mysql', 'cred_mysql',
        'required', 'enabled', 'healthy', 14, 1, ${userB.id}, now(), 'succeeded'
      ) returning id, display_name
    `;

    const [jobA] = await client<{ id: string }[]>`
      insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, attempt_count, started_at, finished_at)
      values (${workspaceA.id}, ${projectA.id}, ${sourcePg.id}, 'manual', ${userA.id}, 'succeeded', 'succeeded', 1, now(), now())
      returning id
    `;
    const [jobB] = await client<{ id: string }[]>`
      insert into backup_jobs (workspace_id, project_id, database_source_id, trigger, requested_by_user_id, status, stage, attempt_count, started_at, finished_at)
      values (${workspaceB.id}, ${projectB.id}, ${sourceMysql.id}, 'manual', ${userB.id}, 'succeeded', 'succeeded', 1, now(), now())
      returning id
    `;

    const storage = new FakeS3Storage();
    const pgDump = createFakeDumpProcess("postgresql", sourcePg.display_name);
    const mysqlDump = createFakeDumpProcess("mysql", sourceMysql.display_name);
    const pgDataKey = new Uint8Array(32).fill(21);
    const mysqlDataKey = new Uint8Array(32).fill(22);
    const encryptedPg = await collectStream(encryptBackupStream(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pgDump.stdout); controller.close(); } }), { dataKey: pgDataKey }));
    const encryptedMysql = await collectStream(encryptBackupStream(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(mysqlDump.stdout); controller.close(); } }), { dataKey: mysqlDataKey }));
    const storedPg = storage.putObject(`${storageA.storage_prefix}/objects/fixture01.enc`, encryptedPg, { fixture: "a1" });
    const storedMysql = storage.putObject(`${storageB.storage_prefix}/objects/fixture02.enc`, encryptedMysql, { fixture: "b1" });

    const [backupA] = await client<{ id: string }[]>`
      insert into backups (
        workspace_id, project_id, database_source_id, backup_job_id, storage_config_id, status, engine, format, object_key, download_filename,
        original_dump_size_bytes, stored_size_bytes, encrypted_checksum, retention_expires_at
      ) values (
        ${workspaceA.id}, ${projectA.id}, ${sourcePg.id}, ${jobA.id}, ${storageA.id}, 'succeeded', 'postgresql', 'postgres_custom', ${storedPg.key}, 'agency-a-20260506.dump',
        ${BigInt(pgDump.stdout.byteLength)}, ${BigInt(pgDump.stdout.byteLength)}, ${storedPg.checksum}, now() + interval '14 days'
      ) returning id
    `;
    const [backupB] = await client<{ id: string }[]>`
      insert into backups (
        workspace_id, project_id, database_source_id, backup_job_id, storage_config_id, status, engine, format, object_key, download_filename,
        original_dump_size_bytes, stored_size_bytes, encrypted_checksum, retention_expires_at
      ) values (
        ${workspaceB.id}, ${projectB.id}, ${sourceMysql.id}, ${jobB.id}, ${storageB.id}, 'succeeded', 'mysql', 'mysql_sql_gzip', ${storedMysql.key}, 'agency-b-20260506.sql.gz',
        ${BigInt(mysqlDump.stdout.byteLength)}, ${BigInt(mysqlDump.stdout.byteLength)}, ${storedMysql.checksum}, now() + interval '14 days'
      ) returning id
    `;

    const wrappedBackupKeyA = await wrapBackupDataKey({ workspaceId: workspaceA.id, backupId: backupA.id, backupDataKey: pgDataKey, workspaceKey: workspaceKeyA });
    const wrappedBackupKeyB = await wrapBackupDataKey({ workspaceId: workspaceB.id, backupId: backupB.id, backupDataKey: mysqlDataKey, workspaceKey: workspaceKeyB });
    await client`
      insert into backup_encryption_keys (workspace_id, backup_id, wrapped_data_key, workspace_key_version, chunk_size_bytes)
      values
        (${workspaceA.id}, ${backupA.id}, ${JSON.stringify(wrappedBackupKeyA)}, 1, 65536),
        (${workspaceB.id}, ${backupB.id}, ${JSON.stringify(wrappedBackupKeyB)}, 1, 65536)
    `;

    const [sessionA] = await client<{ id: string }[]>`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
      values (${userA.id}, ${hashValue('session-a')}, ${hashValue('csrf-a')}, ${workspaceA.id}, now() + interval '1 day')
      returning id
    `;
    const [sessionAdminA] = await client<{ id: string }[]>`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
      values (${adminA.id}, ${hashValue('session-admin-a')}, ${hashValue('csrf-admin-a')}, ${workspaceA.id}, now() + interval '1 day')
      returning id
    `;
    const [sessionMemberA] = await client<{ id: string }[]>`
      insert into sessions (user_id, session_token_hash, csrf_token_hash, active_workspace_id, expires_at)
      values (${memberA.id}, ${hashValue('session-member-a')}, ${hashValue('csrf-member-a')}, ${workspaceA.id}, now() + interval '1 day')
      returning id
    `;

    await client`
      insert into download_requests (backup_id, workspace_id, user_id, session_id_hash, token_hash, expires_at, created_ip, user_agent)
      values (${backupA.id}, ${workspaceA.id}, ${userA.id}, ${hashValue(sessionA.id)}, ${hashValue('download-a')}, now() + interval '15 minutes', '127.0.0.1', 'bun-test')
    `;

    await client`
      insert into audit_logs (
        workspace_id,
        actor_type,
        actor_user_id,
        effective_actor_user_id,
        session_id_hash,
        event_type,
        target_type,
        target_id,
        ip_address,
        user_agent,
        result,
        metadata
      )
      values (
        ${workspaceA.id},
        'user',
        ${userA.id},
        ${userA.id},
        ${hashValue(sessionA.id)},
        'backup.download',
        'backup',
        ${backupA.id},
        '127.0.0.1',
        'bun-test',
        'succeeded',
        '{"seeded":true}'::jsonb
      )
    `;

    return {
      databaseUrl,
      storage,
      appMasterKey,
      workspaceKeys: {
        agencyA: await unwrapWorkspaceKey({ workspaceId: workspaceA.id, wrappedWorkspaceKey: wrappedWorkspaceKeyA, appMasterKey }),
        agencyB: await unwrapWorkspaceKey({ workspaceId: workspaceB.id, wrappedWorkspaceKey: wrappedWorkspaceKeyB, appMasterKey })
      },
      users: { agencyA: userA, agencyB: userB, agencyAAdmin: adminA, agencyAMember: memberA },
      sessions: {
        agencyAOwner: { id: sessionA.id, token: 'session-a', csrf: 'csrf-a' },
        agencyAAdmin: { id: sessionAdminA.id, token: 'session-admin-a', csrf: 'csrf-admin-a' },
        agencyAMember: { id: sessionMemberA.id, token: 'session-member-a', csrf: 'csrf-member-a' }
      },
      workspaces: { agencyA: workspaceA, agencyB: workspaceB },
      projects: { agencyA: projectA, agencyB: projectB },
      sources: { postgres: sourcePg, mysql: sourceMysql },
      backups: { agencyA: backupA, agencyB: backupB },
      dumpProcesses: { postgres: pgDump, mysql: mysqlDump }
    };
  } finally {
    await client.end();
  }
}
