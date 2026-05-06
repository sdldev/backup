import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageFiles = [
  join(import.meta.dir, "../../packages/db/src/backup-jobs.ts"),
  join(import.meta.dir, "../../packages/db/src/backup-retention.ts"),
  join(import.meta.dir, "../../packages/db/src/audit.ts"),
  join(import.meta.dir, "../../packages/db/src/plans.ts"),
  join(import.meta.dir, "../../packages/db/src/testing.ts"),
  join(import.meta.dir, "../../packages/security/src/index.ts")
];

const scopedTables = [
  "projects",
  "database_sources",
  "backup_jobs",
  "backups",
  "workspace_members",
  "download_requests",
  "backup_encryption_keys",
  "cleanup_records",
  "backup_download_locks"
] as const;
const sqlTemplatePattern = /`([\s\S]*?)`/gu;

const offenders: string[] = [];

for (const filePath of packageFiles) {
  const source = readFileSync(filePath, "utf8");
  for (const match of source.matchAll(sqlTemplatePattern)) {
    const statement = match[1];
    const normalized = statement.replace(/\s+/g, " ").trim();
    const touchesScopedTable = scopedTables.some((table) => normalized.includes(` ${table}`) || normalized.includes(` ${table}.`));
    const hasIdPredicate = /where [^`]*\bid\s*=\s*\$\{/.test(normalized);
    const hasWorkspaceScope = /workspace_id\s*=\s*\$\{/.test(normalized);
    const isGlobalLockCleanup = normalized.includes("delete from backup_download_locks") && !normalized.includes("where id = ${");

    if (touchesScopedTable && hasIdPredicate && !hasWorkspaceScope && !isGlobalLockCleanup) {
      offenders.push(`${filePath} -> ${normalized}`);
    }
  }
}

if (offenders.length > 0) {
  console.error("repo.workspace_scope_required");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

console.log("TENANT_SCOPE_STATIC_OK");
