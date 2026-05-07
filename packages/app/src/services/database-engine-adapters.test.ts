import { describe, expect, test } from 'bun:test';
import { buildConnectionTestCommand, buildDumpCommand, runConnectionTestCommand, runDumpCommand, runDumpCommandStream, safeConnectionTestCommandForLog, safeDumpCommandForLog, sanitizeConnectionError, testConnection } from './database-engine-adapters';

describe('Database Engine Adapter scaffold', () => {
  test('sanitizes passwords from errors', () => {
    expect(sanitizeConnectionError(new Error('connect failed password=secret'))).not.toContain('secret');
    expect(sanitizeConnectionError(new Error('postgres://user:secret@example/db'))).not.toContain('secret');
    expect(sanitizeConnectionError(new Error('Password: secret'))).not.toContain('secret');
  });

  test('builds MySQL connection test command without putting password in args', () => {
    const command = buildConnectionTestCommand({
      engine: 'mysql',
      host: 'db.example.com',
      port: 3306,
      database: 'app',
      username: 'root',
      password: 'secret',
      sslMode: 'require',
    });

    expect(command.command).toBe('mysql');
    expect(command.args).toContain('--execute=SELECT VERSION();');
    expect(command.env.MYSQL_PWD).toBe('secret');
    expect(JSON.stringify(command.args)).not.toContain('secret');
    expect(JSON.stringify(safeConnectionTestCommandForLog(command))).not.toContain('secret');
  });

  test('builds PostgreSQL connection test command without putting password in args', () => {
    const command = buildConnectionTestCommand({
      engine: 'postgresql',
      host: 'pg.example.com',
      port: 5432,
      database: 'app',
      username: 'postgres',
      password: 'secret',
      sslMode: 'prefer',
    });

    expect(command.command).toBe('psql');
    expect(command.args).toContain('--command=SHOW server_version;');
    expect(command.env.PGPASSWORD).toBe('secret');
    expect(command.env.PGSSLMODE).toBe('prefer');
    expect(JSON.stringify(command.args)).not.toContain('secret');
    expect(JSON.stringify(safeConnectionTestCommandForLog(command))).not.toContain('secret');
  });

  test('runs connection test command and returns server version', async () => {
    const result = await runConnectionTestCommand({ command: 'bun', args: ['-e', 'process.stdout.write("16.3")'], env: {} });
    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBe('16.3');
  });

  test('sanitizes failing connection stderr', async () => {
    const result = await runConnectionTestCommand({ command: 'bun', args: ['-e', 'process.stderr.write("failed password=secret postgres://user:secret@example/db"); process.exit(2)'], env: {} });
    expect(result.ok).toBe(false);
    expect(result.userErrorMessage).toContain('REDACTED');
    expect(result.userErrorMessage).not.toContain('secret');
  });

  test('builds MySQL dump command without putting password in args', () => {
    const command = buildDumpCommand({
      engine: 'mysql',
      host: 'db.example.com',
      port: 3306,
      database: 'app',
      username: 'root',
      password: 'secret',
      sslMode: 'require',
    });

    expect(command.command).toBe('mysqldump');
    expect(command.args).toContain('--single-transaction');
    expect(command.args).toContain('--routines');
    expect(command.args).toContain('--triggers');
    expect(command.args).toContain('--events');
    expect(command.env.MYSQL_PWD).toBe('secret');
    expect(command.format).toBe('mysql_sql_gzip');
    expect(command.gzipOutput).toBe(true);
    expect(JSON.stringify(command.args)).not.toContain('secret');
    expect(JSON.stringify(safeDumpCommandForLog(command))).not.toContain('secret');
  });

  test('builds PostgreSQL custom dump command without putting password in args', () => {
    const command = buildDumpCommand({
      engine: 'postgresql',
      host: 'pg.example.com',
      port: 5432,
      database: 'app',
      username: 'postgres',
      password: 'secret',
      sslMode: 'prefer',
    });

    expect(command.command).toBe('pg_dump');
    expect(command.args).toContain('--format=custom');
    expect(command.args).toContain('--no-owner');
    expect(command.args).toContain('--no-privileges');
    expect(command.env.PGPASSWORD).toBe('secret');
    expect(command.env.PGSSLMODE).toBe('prefer');
    expect(command.format).toBe('postgres_custom');
    expect(JSON.stringify(command.args)).not.toContain('secret');
    expect(JSON.stringify(safeDumpCommandForLog(command))).not.toContain('secret');
  });

  test('runs dump command and returns stdout bytes', async () => {
    const result = await runDumpCommand({
      command: 'bun',
      args: ['-e', 'process.stdout.write("dump-bytes")'],
      env: {},
      outputExtension: 'dump',
      format: 'postgres_custom',
    });

    expect(new TextDecoder().decode(result.bytes)).toBe('dump-bytes');
    expect(result.originalSizeBytes).toBe(10);
  });

  test('streams dump command output', async () => {
    const result = runDumpCommandStream({
      command: 'bun',
      args: ['-e', 'process.stdout.write("streamed-dump")'],
      env: {},
      outputExtension: 'dump',
      format: 'postgres_custom',
    });

    expect(new TextDecoder().decode(await new Response(result.stream).arrayBuffer())).toBe('streamed-dump');
    expect(await result.processDone).toBe(0);
    expect(await result.stderr).toBe('');
  });

  test('streams gzip-compressed MySQL dump output', async () => {
    const result = runDumpCommandStream({
      command: 'bun',
      args: ['-e', 'process.stdout.write("plain-sql-dump")'],
      env: {},
      outputExtension: 'sql.gz',
      format: 'mysql_sql_gzip',
      gzipOutput: true,
    });

    const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe('plain-sql-dump');
    expect(await result.processDone).toBe(0);
  });

  test('gzip-compresses MySQL dump output while preserving original size', async () => {
    const result = await runDumpCommand({
      command: 'bun',
      args: ['-e', 'process.stdout.write("plain-sql-dump")'],
      env: {},
      outputExtension: 'sql.gz',
      format: 'mysql_sql_gzip',
      gzipOutput: true,
    });

    expect(result.originalSizeBytes).toBe(14);
    expect(result.bytes[0]).toBe(0x1f);
    expect(result.bytes[1]).toBe(0x8b);
    const decompressed = Bun.gunzipSync(new Uint8Array(result.bytes));
    expect(new TextDecoder().decode(decompressed)).toBe('plain-sql-dump');
  });

  test('sanitizes failing dump stderr', async () => {
    await expect(runDumpCommand({
      command: 'bun',
      args: ['-e', 'process.stderr.write("failed password=secret postgres://user:secret@example/db"); process.exit(2)'],
      env: {},
      outputExtension: 'dump',
      format: 'postgres_custom',
    })).rejects.toThrow(/REDACTED/);

    await expect(runDumpCommand({
      command: 'bun',
      args: ['-e', 'process.stderr.write("failed password=secret"); process.exit(2)'],
      env: {},
      outputExtension: 'dump',
      format: 'postgres_custom',
    })).rejects.not.toThrow(/secret/);
  });

  test('validates required payload without leaking password', async () => {
    const result = await testConnection({
      engine: 'mysql',
      host: '',
      port: 3306,
      database: 'app',
      username: 'root',
      password: 'secret',
      sslMode: 'require',
    });

    expect(result.ok).toBe(false);
    expect(result.user_error_message).toBe('Database host is required');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
