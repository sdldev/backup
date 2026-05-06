import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SEEDED_PLANS } from "../../../packages/db/src/plans";
import { createSqlClient } from "../../../packages/db/src/testing";
import { ensureFreshTestSchema, resolveDatabaseUrl } from "../../../scripts/db/_test-db";

const databaseUrl = resolveDatabaseUrl();

setDefaultTimeout(30_000);

beforeAll(async () => {
  await ensureFreshTestSchema(databaseUrl);
});

afterAll(async () => {
  const client = createSqlClient(databaseUrl);
  await client.end({ timeout: 0 });
});

describe("DB seeds", () => {
  test("plans seed exactly Basic, Pro, Agency documented limits", async () => {
    const client = createSqlClient(databaseUrl);

    try {
      const rows = await client<{
        slug: string;
        display_name: string;
        is_request_only: boolean;
        database_source_limit: number;
        retained_storage_bytes_limit: string;
        retention_days_max: number;
        schedule_frequency_per_day_max: number;
        workspace_member_limit: number;
        manual_backup_per_hour_limit: number;
      }[]>`
        select
          slug::text,
          display_name,
          is_request_only,
          database_source_limit,
          retained_storage_bytes_limit,
          retention_days_max,
          schedule_frequency_per_day_max,
          workspace_member_limit,
          manual_backup_per_hour_limit
        from plans
        order by slug::text asc
      `;

      expect(rows).toHaveLength(3);
      expect(
        rows.map((row) => ({
          slug: row.slug,
          displayName: row.display_name,
          isRequestOnly: row.is_request_only,
          databaseSourceLimit: row.database_source_limit,
          retainedStorageBytesLimit: BigInt(row.retained_storage_bytes_limit),
          retentionDaysMax: row.retention_days_max,
          scheduleFrequencyPerDayMax: row.schedule_frequency_per_day_max,
          workspaceMemberLimit: row.workspace_member_limit,
          manualBackupPerHourLimit: row.manual_backup_per_hour_limit
        }))
      ).toEqual([...SEEDED_PLANS].sort((left, right) => left.slug.localeCompare(right.slug)));
    } finally {
      await client.end();
    }
  });
});

describe("workspace owner invariant", () => {
  test("transaction cannot commit second owner", async () => {
    const client = createSqlClient(databaseUrl);

    try {
      const [basicPlan] = await client<{ id: string }[]>`select id from plans where slug = 'basic' limit 1`;
      const [ownerOne] = await client<{ id: string }[]>`
        insert into users (email, name)
        values ('owner1@example.com', 'Owner One')
        returning id
      `;
      const [ownerTwo] = await client<{ id: string }[]>`
        insert into users (email, name)
        values ('owner2@example.com', 'Owner Two')
        returning id
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (name, slug, timezone, plan_id)
        values ('Acme', 'acme', 'UTC', ${basicPlan.id})
        returning id
      `;

      await client`
        insert into workspace_members (workspace_id, user_id, role)
        values (${workspace.id}, ${ownerOne.id}, 'owner')
      `;

      await expect(
        client.begin(async (transaction) => {
          await transaction`
            insert into workspace_members (workspace_id, user_id, role)
            values (${workspace.id}, ${ownerTwo.id}, 'owner')
          `;
        })
      ).rejects.toThrow(/more than one owner|duplicate key value/i);

      const owners = await client<{ count: string }[]>`
        select count(*)::text as count
        from workspace_members
        where workspace_id = ${workspace.id}
          and role = 'owner'
      `;

      expect(owners[0]?.count).toBe("1");
    } finally {
      await client.end();
    }
  });
});
