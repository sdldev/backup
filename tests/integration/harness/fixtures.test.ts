import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSqlClient } from "../../../packages/db/src/testing";
import { seedHarnessFixtures, type SeededHarness } from "../../harness/fixtures";

let harness: SeededHarness;

beforeAll(async () => {
  harness = await seedHarnessFixtures();
});

afterAll(async () => {
  const client = createSqlClient(harness.databaseUrl);
  await client.end({ timeout: 0 });
});

describe("fixture isolation", () => {
  test("required identities and tenant labels exist exactly once", async () => {
    const client = createSqlClient(harness.databaseUrl);

    try {
      const users = await client<{ email: string }[]>`
        select email from users order by email asc
      `;
      const workspaces = await client<{ slug: string }[]>`
        select slug from workspaces order by slug asc
      `;
      const sources = await client<{ display_name: string }[]>`
        select display_name from database_sources order by display_name asc
      `;

      expect(users.map((row) => row.email)).toEqual([
        "agency-a-admin@example.com",
        "agency-a-member@example.com",
        "agency-a@example.com",
        "agency-b@example.com"
      ]);
      expect(workspaces.map((row) => row.slug)).toEqual(["ws_agency_a", "ws_agency_b"]);
      expect(sources.map((row) => row.display_name)).toEqual(["src_mysql_prod_1", "src_pg_prod_1"]);
    } finally {
      await client.end();
    }
  });

  test("fake storage supports exists, absent, and checksum assertions", () => {
    const keys = harness.storage.listKeys();

    expect(keys).toEqual(["opaque/o1/objects/fixture01.enc", "opaque/o2/objects/fixture02.enc"]);

    const object = harness.storage.assertObjectExists("opaque/o1/objects/fixture01.enc");
    harness.storage.assertChecksum(object.key, object.checksum);

    harness.storage.deleteObject("opaque/o2/objects/fixture02.enc");
    harness.storage.assertObjectAbsent("opaque/o2/objects/fixture02.enc");
  });

  test("fake dump processes stay deterministic", () => {
    expect(new TextDecoder().decode(harness.dumpProcesses.postgres.stdout)).toContain("src_pg_prod_1");
    expect(harness.dumpProcesses.postgres.command[0]).toBe("pg_dump");
    expect(harness.dumpProcesses.mysql.command[0]).toBe("mysqldump");
  });
});
