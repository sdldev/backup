import { formatSecurityList, getSecurityDefinitions } from "../harness/security";

const args = process.argv.slice(2);

if (args.includes("--list")) {
  console.log(formatSecurityList());
  process.exit(0);
}

const groups = args.filter((item, index) => {
  if (item.startsWith("--")) {
    return false;
  }

  const previous = args[index - 1] ?? "";
  return previous !== "--parallel" && previous !== "--max-concurrency" && previous !== "--timeout";
});
const passthroughFlags = args.filter((item, index) => {
  if (item.startsWith("--")) {
    return true;
  }

  const previous = args[index - 1] ?? "";
  return previous === "--parallel" || previous === "--max-concurrency" || previous === "--timeout";
});

const staticGateCommands = [
  ["bun", "run", "security:routes"],
  ["bun", "run", "security:tenant-scope"],
  ["bun", "run", "security:object-keys"],
  ["bun", "run", "security:rollback-notes"]
];

for (const command of staticGateCommands) {
  const gate = Bun.spawnSync(command, {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env
  });

  if (gate.exitCode !== 0) {
    process.exit(gate.exitCode);
  }
}

const proc = Bun.spawnSync(["bun", "test", "tests/security", ...passthroughFlags], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    SECURITY_GROUPS: groups.length > 0 ? groups.join(",") : getSecurityDefinitions().map((item) => item.group).join(",")
  }
});

const stdout = proc.stdout.toString();
const stderr = proc.stderr.toString();
if (stdout.length > 0) {
  process.stdout.write(stdout);
}
if (stderr.length > 0) {
  process.stderr.write(stderr);
}

const activeGroups = new Set(groups.length > 0 ? groups : getSecurityDefinitions().map((item) => item.group));
const requiredMarkers = getSecurityDefinitions()
  .filter((item) => activeGroups.has(item.group))
  .map((item) => item.marker);

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode);
}

const missingMarkers = requiredMarkers.filter((marker) => !stdout.includes(marker) && !stderr.includes(marker));
if (missingMarkers.length > 0) {
  console.error(`Missing security invariant markers: ${missingMarkers.join(", ")}`);
  process.exit(1);
}

if (requiredMarkers.length === getSecurityDefinitions().length && !stdout.includes("SECURITY_INVARIANTS_OK") && !stderr.includes("SECURITY_INVARIANTS_OK")) {
  console.error("Missing security summary marker: SECURITY_INVARIANTS_OK");
  process.exit(1);
}

process.exit(0);
