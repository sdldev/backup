import { createSqlClient } from "../packages/db/src/testing";
import { reconcileBackupObjectsDryRun } from "../apps/worker/src/index";
import { seedHarnessFixtures } from "../tests/harness/fixtures";

async function main() {
  const [, , ...args] = Bun.argv;

  if (!args.includes("--dry-run")) {
    console.error("Only --dry-run is supported for worker reconcile safety command.");
    process.exit(1);
  }

  const seeded = await seedHarnessFixtures();
  const client = createSqlClient(seeded.databaseUrl);

  try {
    seeded.storage.putObject("opaque/o1/objects/reconcile-orphan.enc", "orphan", { idempotencyKey: "test:orphan" });
    const report = await reconcileBackupObjectsDryRun({
      client,
      storage: seeded.storage,
      storagePrefix: "opaque/o1"
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

await main();
