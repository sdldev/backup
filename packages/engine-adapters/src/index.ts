export type SupportedDatabaseEngine = "mysql" | "postgresql";

export type MysqlSslMode = "disabled" | "preferred" | "required" | "verify_ca" | "verify_identity";
export type PostgresSslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
export type SupportedSslMode = MysqlSslMode | PostgresSslMode;

export type ConnectionTestInput = {
  engine: SupportedDatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SupportedSslMode;
};

export type ConnectionTestSuccess = {
  status: "succeeded";
  connectivity: true;
  serverVersion: string;
  databaseExists: boolean;
  tlsEnabled: boolean;
  dumpCapability: {
    ok: boolean;
    warning: string | null;
  };
  sizeEstimateBytes: bigint | null;
  sizeEstimateWarning: string | null;
};

export type ConnectionTestFailureCode =
  | "connection_failed"
  | "authentication_failed"
  | "database_missing"
  | "permission_denied"
  | "tls_required"
  | "timeout"
  | "cancelled"
  | "unknown";

export type ConnectionTestFailure = {
  status: "failed";
  connectivity: false;
  code: ConnectionTestFailureCode;
  message: string;
  detail: string | null;
};

export type ConnectionTestResult = ConnectionTestSuccess | ConnectionTestFailure;

export type DumpFormat = "mysql_sql_gzip" | "postgres_custom";

export type DumpCommand = {
  argv: string[];
  env: Record<string, string>;
  redactedArgv: string[];
  redactedEnv: Record<string, string>;
  timeoutMs: number;
  supportsCancellation: true;
  format: DumpFormat;
};

export type DumpProcessResult = {
  exitCode: number | null;
  signalCode?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
  stderr?: string;
  stdout?: string;
};

export type DumpFailureCode = "ok" | "permission_denied" | "cancelled" | "timeout" | "tool_missing" | "failed";

export type DumpProcessSummary = {
  ok: boolean;
  code: DumpFailureCode;
  exitCode: number | null;
  message: string;
  stderr: string;
  stdout: string;
};

export type EngineAdapter = {
  engine: SupportedDatabaseEngine;
  createDumpCommand(input: ConnectionTestInput, options?: { timeoutMs?: number }): DumpCommand;
  classifyDumpResult(result: DumpProcessResult, input?: ConnectionTestInput): DumpProcessSummary;
  sanitizeError(error: unknown, input?: ConnectionTestInput): ConnectionTestFailure;
};

const defaultDumpTimeoutMs = 5 * 60 * 1000;
const redactionToken = "**redacted**";

const mysqlExitCodeMap: Record<number, DumpFailureCode> = {
  0: "ok",
  1: "failed",
  2: "permission_denied",
  127: "tool_missing"
};

const postgresExitCodeMap: Record<number, DumpFailureCodeWithConnection> = {
  0: "ok",
  1: "failed",
  2: "connection_failed",
  127: "tool_missing"
};

type DumpFailureCodeWithConnection = DumpFailureCode | "connection_failed";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeText(value: string, input: Pick<ConnectionTestInput, "password" | "username" | "host" | "database">): string {
  let sanitized = value;
  const replacements = [
    input.password,
    input.username,
    input.host,
    input.database,
    `${input.username}:${input.password}`,
    `${input.username}@${input.host}`,
    `${input.username}:${input.password}@${input.host}`
  ].filter(Boolean);

  for (const secret of replacements) {
    sanitized = sanitized.split(secret).join(redactionToken);
  }

  sanitized = sanitized.replace(/([A-Za-z]+:\/\/)([^\s:@]+):([^\s@]+)@/g, `$1${redactionToken}:${redactionToken}@`);
  sanitized = sanitized.replace(/(password\s*[=:]\s*)([^\s,;]+)/gi, `$1${redactionToken}`);
  sanitized = sanitized.replace(/(user(name)?\s*[=:]\s*)([^\s,;]+)/gi, `$1${redactionToken}`);

  return sanitized;
}

function createDumpSummary(
  result: DumpProcessResult,
  code: DumpFailureCodeWithConnection,
  stderr: string,
  stdout: string
): DumpProcessSummary {
  if (code === "ok") {
    return { ok: true, code, exitCode: result.exitCode, message: "Dump command succeeded.", stderr, stdout };
  }

  const messageByCode: Record<Exclude<DumpFailureCodeWithConnection, "ok">, string> = {
    cancelled: "Dump command cancelled.",
    timeout: "Dump command timed out.",
    tool_missing: "Dump tool not available in worker runtime.",
    permission_denied: "Dump permission check failed.",
    connection_failed: "Dump tool could not connect to source database.",
    failed: "Dump command failed."
  };

  return { ok: false, code: code === "connection_failed" ? "failed" : code, exitCode: result.exitCode, message: messageByCode[code], stderr, stdout };
}

function sanitizeUnknownError(error: unknown, input: ConnectionTestInput): ConnectionTestFailure {
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown adapter error.";
  const rawCode = isObject(error) && typeof error.code === "string" ? error.code : null;
  const message = sanitizeText(rawMessage, input);

  if (/access denied|authentication failed|password authentication failed/i.test(rawMessage)) {
    return { status: "failed", connectivity: false, code: "authentication_failed", message: "Authentication failed.", detail: message };
  }
  if (/unknown database|database .* does not exist|3D000/i.test(rawMessage)) {
    return { status: "failed", connectivity: false, code: "database_missing", message: "Database does not exist.", detail: message };
  }
  if (/ssl|tls/i.test(rawMessage) || rawCode === "HANDSHAKE_SSL_ERROR") {
    return { status: "failed", connectivity: false, code: "tls_required", message: "TLS negotiation failed.", detail: message };
  }
  if (/permission denied|denied to user|must be owner/i.test(rawMessage)) {
    return { status: "failed", connectivity: false, code: "permission_denied", message: "Database permissions insufficient.", detail: message };
  }
  if (/timeout/i.test(rawMessage) || rawCode === "ETIMEDOUT") {
    return { status: "failed", connectivity: false, code: "timeout", message: "Connection test timed out.", detail: message };
  }
  if (/cancel/i.test(rawMessage) || rawCode === "ABORT_ERR") {
    return { status: "failed", connectivity: false, code: "cancelled", message: "Connection test cancelled.", detail: message };
  }

  return { status: "failed", connectivity: false, code: "unknown", message: "Connection test failed.", detail: message };
}

function createFallbackInput(engine: SupportedDatabaseEngine): ConnectionTestInput {
  return {
    engine,
    host: "db.internal",
    port: engine === "mysql" ? 3306 : 5432,
    database: "database",
    username: "user",
    password: "password",
    sslMode: engine === "mysql" ? "required" : "require"
  };
}

function createMysqlDumpCommand(input: ConnectionTestInput, timeoutMs = defaultDumpTimeoutMs): DumpCommand {
  return {
    argv: [
      "mysqldump",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--events",
      `--host=${input.host}`,
      `--port=${String(input.port)}`,
      `--user=${input.username}`,
      `--ssl-mode=${input.sslMode}`,
      input.database
    ],
    env: { MYSQL_PWD: input.password },
    redactedArgv: [
      "mysqldump",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--events",
      `--host=${redactionToken}`,
      `--port=${String(input.port)}`,
      `--user=${redactionToken}`,
      `--ssl-mode=${input.sslMode}`,
      redactionToken
    ],
    redactedEnv: { MYSQL_PWD: redactionToken },
    timeoutMs,
    supportsCancellation: true,
    format: "mysql_sql_gzip"
  };
}

function createPostgresDumpCommand(input: ConnectionTestInput, timeoutMs = defaultDumpTimeoutMs): DumpCommand {
  return {
    argv: [
      "pg_dump",
      "-Fc",
      `--host=${input.host}`,
      `--port=${String(input.port)}`,
      `--username=${input.username}`,
      `--dbname=${input.database}`
    ],
    env: {
      PGPASSWORD: input.password,
      PGSSLMODE: input.sslMode
    },
    redactedArgv: [
      "pg_dump",
      "-Fc",
      `--host=${redactionToken}`,
      `--port=${String(input.port)}`,
      `--username=${redactionToken}`,
      `--dbname=${redactionToken}`
    ],
    redactedEnv: {
      PGPASSWORD: redactionToken,
      PGSSLMODE: input.sslMode
    },
    timeoutMs,
    supportsCancellation: true,
    format: "postgres_custom"
  };
}

function classifyDumpResultWithMap(
  map: Readonly<Record<number, DumpFailureCodeWithConnection>>,
  result: DumpProcessResult,
  sanitize: (value: string) => string
): DumpProcessSummary {
  const stderr = sanitize(result.stderr ?? "");
  const stdout = sanitize(result.stdout ?? "");

  if (result.cancelled) {
    return createDumpSummary(result, "cancelled", stderr, stdout);
  }
  if (result.timedOut) {
    return createDumpSummary(result, "timeout", stderr, stdout);
  }
  if (result.exitCode === null) {
    return createDumpSummary(result, "failed", stderr, stdout);
  }

  const code = map[result.exitCode] ?? "failed";
  return createDumpSummary(result, code, stderr, stdout);
}

function createAdapter(engine: SupportedDatabaseEngine): EngineAdapter {
  return {
    engine,
    createDumpCommand(input, options) {
      return engine === "mysql"
        ? createMysqlDumpCommand(input, options?.timeoutMs)
        : createPostgresDumpCommand(input, options?.timeoutMs);
    },
    classifyDumpResult(result, input = createFallbackInput(engine)) {
      const sanitize = (value: string) => sanitizeText(value, input);

      return classifyDumpResultWithMap(engine === "mysql" ? mysqlExitCodeMap : postgresExitCodeMap, result, sanitize);
    },
    sanitizeError(error, input = createFallbackInput(engine)) {
      return sanitizeUnknownError(error, input);
    }
  };
}

export const mysqlAdapter = createAdapter("mysql");
export const postgresqlAdapter = createAdapter("postgresql");

export function createEngineAdapter(engine: SupportedDatabaseEngine): EngineAdapter {
  return engine === "mysql" ? mysqlAdapter : postgresqlAdapter;
}

export function createConnectionTestSuccess(input: {
  serverVersion: string;
  databaseExists: boolean;
  tlsEnabled: boolean;
  dumpCapabilityWarning?: string | null;
  sizeEstimateBytes?: bigint | null;
  sizeEstimateWarning?: string | null;
}): ConnectionTestSuccess {
  return {
    status: "succeeded",
    connectivity: true,
    serverVersion: input.serverVersion,
    databaseExists: input.databaseExists,
    tlsEnabled: input.tlsEnabled,
    dumpCapability: {
      ok: true,
      warning: input.dumpCapabilityWarning ?? null
    },
    sizeEstimateBytes: input.sizeEstimateBytes ?? null,
    sizeEstimateWarning: input.sizeEstimateWarning ?? null
  };
}

export function sanitizeConnectionTestError(
  engine: SupportedDatabaseEngine,
  error: unknown,
  input?: ConnectionTestInput
): ConnectionTestFailure {
  return createEngineAdapter(engine).sanitizeError(error, input);
}

export function adaptersSmoke(): string {
  return "engine-adapters";
}
