import { describe, expect, test } from "bun:test";

import {
  createConnectionTestSuccess,
  createEngineAdapter,
  postgresqlAdapter,
  sanitizeConnectionTestError
} from "./index";

describe("postgres.connection-test", () => {
  test("builds pg_dump command with env password and no shell interpolation", () => {
    const command = postgresqlAdapter.createDumpCommand({
      engine: "postgresql",
      host: "pg.internal",
      port: 5432,
      database: "agency_prod",
      username: "postgres",
      password: "super-secret-password",
      sslMode: "require"
    });

    expect(command.argv).toEqual([
      "pg_dump",
      "-Fc",
      "--host=pg.internal",
      "--port=5432",
      "--username=postgres",
      "--dbname=agency_prod"
    ]);
    expect(command.env).toEqual({ PGPASSWORD: "super-secret-password", PGSSLMODE: "require" });
    expect(command.redactedEnv).toEqual({ PGPASSWORD: "**redacted**", PGSSLMODE: "require" });
    expect(command.format).toBe("postgres_custom");
    expect(command.supportsCancellation).toBeTrue();
  });

  test("sanitizes postgres auth failure", () => {
    const failure = sanitizeConnectionTestError(
      "postgresql",
      new Error("password authentication failed for user postgres on postgres://postgres:super-secret-password@pg.internal/agency_prod"),
      {
        engine: "postgresql",
        host: "pg.internal",
        port: 5432,
        database: "agency_prod",
        username: "postgres",
        password: "super-secret-password",
        sslMode: "require"
      }
    );

    expect(failure.code).toBe("authentication_failed");
    expect(failure.message).toBe("Authentication failed.");
    expect(failure.detail).not.toContain("super-secret-password");
    expect(failure.detail).not.toContain("pg.internal");
    expect(failure.detail).not.toContain("agency_prod");
  });

  test("size estimate warning stays non-blocking", () => {
    const result = createConnectionTestSuccess({
      serverVersion: "PostgreSQL 16.3",
      databaseExists: true,
      tlsEnabled: true,
      sizeEstimateBytes: 1024n,
      sizeEstimateWarning: "Estimated size may exceed remaining workspace storage."
    });

    expect(result.status).toBe("succeeded");
    expect(result.sizeEstimateBytes).toBe(1024n);
    expect(result.sizeEstimateWarning).toContain("may exceed");
  });
});

describe("mysql", () => {
  test("builds mysqldump command with supported flags and env password only", () => {
    const command = createEngineAdapter("mysql").createDumpCommand({
      engine: "mysql",
      host: "mysql.internal",
      port: 3306,
      database: "agency_prod",
      username: "root",
      password: "mysql-secret-password",
      sslMode: "required"
    });

    expect(command.argv).toEqual([
      "mysqldump",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--events",
      "--host=mysql.internal",
      "--port=3306",
      "--user=root",
      "--ssl-mode=required",
      "agency_prod"
    ]);
    expect(command.env).toEqual({ MYSQL_PWD: "mysql-secret-password" });
    expect(command.redactedEnv).toEqual({ MYSQL_PWD: "**redacted**" });
    expect(command.format).toBe("mysql_sql_gzip");
  });

  test("maps cancellation and timeout to stable codes", () => {
    const adapter = createEngineAdapter("mysql");
    expect(adapter.classifyDumpResult({ exitCode: null, cancelled: true, stderr: "killed" })).toMatchObject({ ok: false, code: "cancelled" });
    expect(adapter.classifyDumpResult({ exitCode: 1, timedOut: true, stderr: "timed out" })).toMatchObject({ ok: false, code: "timeout" });
  });

  test("sanitizes mysql database-missing failure and stderr output", () => {
    const adapter = createEngineAdapter("mysql");
    const input = {
      engine: "mysql" as const,
      host: "mysql.internal",
      port: 3306,
      database: "agency_prod",
      username: "root",
      password: "mysql-secret-password",
      sslMode: "required" as const
    };
    const failure = sanitizeConnectionTestError("mysql", "Unknown database 'agency_prod' for root@mysql.internal with password=mysql-secret-password", input);
    const dump = adapter.classifyDumpResult({
      exitCode: 2,
      stderr: "mysqldump: Got error: 1044: Access denied for user root using password: YES",
      stdout: "connected as root"
    }, input);

    expect(failure.code).toBe("database_missing");
    expect(failure.detail).not.toContain("mysql-secret-password");
    expect(dump.stderr).not.toContain("mysql-secret-password");
    expect(dump.stderr).not.toContain("mysql.internal");
    expect(dump.stderr).not.toContain("root");
    expect(dump.stdout).not.toContain("root");
    expect(dump.code).toBe("permission_denied");
  });
});
