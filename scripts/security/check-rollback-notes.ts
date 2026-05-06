import { readFileSync } from "node:fs";
import { join } from "node:path";

const rollbackPath = join(import.meta.dir, "../../packages/db/migrations/ROLLBACK.md");
const rollbackNotes = readFileSync(rollbackPath, "utf8");
const requiredSnippets = [
  "Rollback notes",
  "restore whole database from pre-migration backup",
  "Irreversible data warning",
  "Safe restore expectation",
  "Run `bun run db:migrate:test`",
  "Run `bun run db:seed:test`"
];

const missing = requiredSnippets.filter((snippet) => !rollbackNotes.includes(snippet));

if (missing.length > 0) {
  console.error("migration.rollback_notes_required");
  for (const item of missing) {
    console.error(`- missing: ${item}`);
  }
  process.exit(1);
}

console.log("ROLLBACK_NOTES_OK");
