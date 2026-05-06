import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureFiles = [
  join(import.meta.dir, "../../tests/harness/fixtures.ts"),
  join(import.meta.dir, "../../tests/integration/backup-retention.test.ts"),
  join(import.meta.dir, "../../tests/integration/plans-limits.test.ts"),
  join(import.meta.dir, "../../tests/integration/backup-pipeline.test.ts")
];

const forbiddenSubstrings = [
  "slug",
  "name",
  "source",
  "database",
  "user",
  "agency-a",
  "agency-b",
  "ws-a",
  "backup-a",
  "backup-b"
];

const objectKeyLiteralPatterns = [
  /putObject\(("[^"]+"|'[^']+')/gu,
  /assertObject(?:Exists|Absent)\(("[^"]+"|'[^']+')/gu,
  /assertChecksum\(("[^"]+"|'[^']+')/gu,
  /values\s*\([^\n]{0,400}("opaque\/[^"]+"|'opaque\/[^']+')/gu
] as const;
const offenders: string[] = [];

for (const filePath of fixtureFiles) {
  const source = readFileSync(filePath, "utf8");
  for (const pattern of objectKeyLiteralPatterns) {
    for (const match of source.matchAll(pattern)) {
      const literal = (match[1] ?? "").slice(1, -1);
      const normalized = literal.toLowerCase();
      const hit = forbiddenSubstrings.find((part) => normalized.includes(part));
      if (hit) {
        offenders.push(`${filePath} -> ${hit} -> ${literal}`);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error("object_key.leak_forbidden");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

console.log("OBJECT_KEY_FIXTURES_OK");
