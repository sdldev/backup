import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const apiSourceDir = join(import.meta.dir, "../../apps/api/src");
const futureSurfacePatterns = [
  /["'`]\/workspaces\/:workspaceId\/(?:notification-settings|notification|notifications|webhook|webhooks)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/(?:schedule|schedules)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/(?:backup-storage|byos)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/storage\/(?:create|test|activate|retire)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/backup-storage\/(?:create|test|activate|retire)(?:\/|["'`])/u,
  /["'`]\/workspaces\/:workspaceId\/backups\/:backupId\/restore(?:\/|["'`])/u
];

const offenders = readdirSync(apiSourceDir)
  .filter((name) => name.endsWith(".ts"))
  .flatMap((name) => {
    const filePath = join(apiSourceDir, name);
    const source = readFileSync(filePath, "utf8");
    return futureSurfacePatterns.some((pattern) => pattern.test(source)) ? [filePath] : [];
  });

if (offenders.length > 0) {
  console.error("route.future_scope_forbidden");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

console.log("ROUTE_INVENTORY_OK");
