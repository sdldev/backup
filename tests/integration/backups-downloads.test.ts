import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { createApi } from "../../apps/api/src/index";
import { resetRateLimitsForTests } from "../../apps/api/src/rate-limit";
import { createSqlClient } from "../../packages/db/src/testing";
import { seedHarnessFixtures } from "../harness/fixtures";

setDefaultTimeout(30_000);

describe("backup downloads integration", () => {
  test("stream consumes token, removes lock on close, audit records result", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB,
        heartbeatMs: 2,
        lockTtlMs: 25
      }
    });

    const createResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a", "x-request-id": "int-download-create" }
    }));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { downloadToken: string };

    const streamResponse = await app.handle(new Request(`http://localhost/v1/downloads/${created.downloadToken}`, {
      headers: { cookie: "mba_session=session-a", "x-request-id": "int-download-stream" }
    }));
    expect(streamResponse.status).toBe(200);
    await streamResponse.arrayBuffer();

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const [requestRow] = await client<{ consumed: boolean }[]>`
        select consumed_at is not null as consumed
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
        order by created_at desc
        limit 1
      `;
      expect(requestRow.consumed).toBeTrue();

      const [lockRow] = await client<{ count: string }[]>`
        select count(*)::text as count
        from backup_download_locks
        where backup_id = ${seeded.backups.agencyA.id}
      `;
      expect(lockRow.count).toBe("0");

      const [auditRow] = await client<{ count: string }[]>`
        select count(*)::text as count
        from audit_logs
        where workspace_id = ${seeded.workspaces.agencyA.id}
          and event_type = 'backup.download'
          and request_id in ('int-download-create', 'int-download-stream')
      `;
      expect(Number(auditRow.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await client.end();
    }
  });

  test("failed stream after consume leaves token consumed", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async () => new Uint8Array(32).fill(99)
      }
    });

    const createResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a", "x-request-id": "int-download-fail-create" }
    }));
    const created = await createResponse.json() as { downloadToken: string };

    const failed = await app.handle(new Request(`http://localhost/v1/downloads/${created.downloadToken}`, {
      headers: { cookie: "mba_session=session-a", "x-request-id": "int-download-fail-stream" }
    }));
    expect(failed.status).toBe(500);

    const client = createSqlClient(seeded.databaseUrl);
    try {
      const [requestRow] = await client<{ consumed: boolean }[]>`
        select consumed_at is not null as consumed
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
        order by created_at desc
        limit 1
      `;
      expect(requestRow.consumed).toBeTrue();
    } finally {
      await client.end();
    }
  });

  test("restore docs include manual mysql/postgresql commands and no execution form", async () => {
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB
      }
    });

    const docsResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/restore-docs`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(docsResponse.status).toBe(200);
    const docsHtml = await docsResponse.text();
    expect(docsHtml).toContain("gunzip -c backup.sql.gz");
    expect(docsHtml).toContain("pg_restore --host &lt;HOST&gt;");
    expect(docsHtml).toContain("Production overwrite warning");
    expect(docsHtml).not.toContain("<form");
    expect(docsHtml).not.toContain('method="post"');

    const backupDocsResponse = await app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/restore-docs`, {
      headers: { cookie: "mba_session=session-a" }
    }));
    expect(backupDocsResponse.status).toBe(200);
    const backupHtml = await backupDocsResponse.text();
    expect(backupHtml).toContain("agency-a-20260506.dump");
    expect(backupHtml).toContain("pg_restore --host &lt;HOST&gt;");
    expect(backupHtml).not.toContain("<button");
    expect(backupHtml).not.toContain("action=");
  });

  test("download token creation rate limit returns 429 and creates no extra token", async () => {
    resetRateLimitsForTests();
    const seeded = await seedHarnessFixtures();
    const app = createApi({
      auth: { databaseUrl: seeded.databaseUrl },
      workspaces: { databaseUrl: seeded.databaseUrl },
      audit: { databaseUrl: seeded.databaseUrl },
      backups: {
        databaseUrl: seeded.databaseUrl,
        storage: seeded.storage,
        resolveWorkspaceKey: async (workspaceId) => workspaceId === seeded.workspaces.agencyA.id ? seeded.workspaceKeys.agencyA : seeded.workspaceKeys.agencyB,
        rateLimit: { max: 1, windowMs: 60_000 }
      }
    });

    const client = createSqlClient(seeded.databaseUrl);
    let beforeCount = "0";
    try {
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
      `;
      beforeCount = row.count;
    } finally {
      await client.end();
    }

    const request = () => app.handle(new Request(`http://localhost/v1/workspaces/${seeded.workspaces.agencyA.id}/backups/${seeded.backups.agencyA.id}/download-requests`, {
      method: "POST",
      headers: { cookie: "mba_session=session-a; mba_csrf=csrf-a", "x-csrf-token": "csrf-a", "x-request-id": "rate-download" }
    }));

    const first = await request();
    const second = await request();
    const body = await second.json() as { error: { code: string } };

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(body).toEqual({ error: { code: "rate_limit.exceeded" } });

    const verifyClient = createSqlClient(seeded.databaseUrl);
    try {
      const [row] = await verifyClient<{ count: string }[]>`
        select count(*)::text as count
        from download_requests
        where backup_id = ${seeded.backups.agencyA.id}
      `;
      expect(Number(row.count) - Number(beforeCount)).toBe(1);
    } finally {
      await verifyClient.end();
    }
  });
});
