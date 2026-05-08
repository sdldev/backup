export type ConnectionTestInput = {
  engine: 'mysql' | 'postgresql';
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string | undefined;
  sslMode: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  server_version: string | null;
  tls: 'required' | 'preferred' | 'disabled' | 'unknown';
  can_dump: boolean;
  user_error_message: string | null;
};

export type DumpCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
  outputExtension: 'sql.gz' | 'dump';
  format: 'mysql_sql_gzip' | 'postgres_custom';
  gzipOutput?: boolean;
};

export type DumpRunResult = {
  bytes: Uint8Array;
  originalSizeBytes: number;
};

export type DumpStreamRunResult = {
  stream: ReadableStream<Uint8Array>;
  processDone: Promise<number>;
  stderr: Promise<string>;
};

type ConnectionTestCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type ConnectionTestRunResult = {
  ok: boolean;
  serverVersion: string | null;
  userErrorMessage: string | null;
};

export async function testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const validationError = validateConnectionPayload(input);
  if (validationError) {
    return failed(validationError);
  }

  const command = buildConnectionTestCommand(input);
  const result = await runConnectionTestCommand(command);
  return {
    ok: result.ok,
    server_version: result.serverVersion,
    tls: input.sslMode === 'disable' ? 'disabled' : input.sslMode === 'prefer' ? 'preferred' : 'required',
    can_dump: result.ok,
    user_error_message: result.ok ? null : result.userErrorMessage,
  };
}

export function buildConnectionTestCommand(input: ConnectionTestInput): ConnectionTestCommand {
  const validationError = validateConnectionPayload(input);
  if (validationError) throw new Error(validationError);

  if (input.engine === 'mysql') {
    return {
      command: Bun.env.BACKUP_MYSQL_CLIENT_COMMAND ?? 'mysql',
      args: [
        '--batch',
        '--skip-column-names',
        `--host=${input.host}`,
        `--port=${input.port}`,
        `--user=${input.username}`,
        '--execute=SELECT VERSION();',
        input.database,
      ],
      env: input.password ? { MYSQL_PWD: input.password } : {},
    };
  }

  return {
    command: Bun.env.BACKUP_POSTGRES_CLIENT_COMMAND ?? 'psql',
    args: [
      `--host=${input.host}`,
      `--port=${input.port}`,
      `--username=${input.username}`,
      '--tuples-only',
      '--no-align',
      '--command=SHOW server_version;',
      input.database,
    ],
    env: {
      ...(input.password ? { PGPASSWORD: input.password } : {}),
      PGSSLMODE: input.sslMode === 'disable' ? 'disable' : input.sslMode === 'prefer' ? 'prefer' : 'require',
    },
  };
}

export async function runConnectionTestCommand(command: ConnectionTestCommand): Promise<ConnectionTestRunResult> {
  const proc = Bun.spawn([command.command, ...command.args], {
    env: { ...Bun.env, ...command.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return { ok: false, serverVersion: null, userErrorMessage: sanitizeConnectionError(new Error(stderr || `${command.command} exited with code ${exitCode}`)) };
  }

  return { ok: true, serverVersion: stdout.trim().split('\n')[0]?.trim() || null, userErrorMessage: null };
}

export function safeConnectionTestCommandForLog(command: ConnectionTestCommand) {
  return {
    command: command.command,
    args: command.args,
    env: Object.fromEntries(Object.keys(command.env).map((key) => [key, '[REDACTED]'])),
  };
}

export function buildDumpCommand(input: ConnectionTestInput): DumpCommand {
  const validationError = validateConnectionPayload(input);
  if (validationError) throw new Error(validationError);

  if (input.engine === 'mysql') {
    return {
      command: Bun.env.BACKUP_MYSQL_DUMP_COMMAND ?? 'mysqldump',
      args: [
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        `--host=${input.host}`,
        `--port=${input.port}`,
        `--user=${input.username}`,
        input.database,
      ],
      env: input.password ? { MYSQL_PWD: input.password } : {},
      outputExtension: 'sql.gz',
      format: 'mysql_sql_gzip',
      gzipOutput: true,
    };
  }

  return {
    command: Bun.env.BACKUP_POSTGRES_DUMP_COMMAND ?? 'pg_dump',
    args: [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--host=${input.host}`,
      `--port=${input.port}`,
      `--username=${input.username}`,
      input.sslMode === 'disable' ? '--dbname' : '--dbname',
      input.database,
    ],
    env: {
      ...(input.password ? { PGPASSWORD: input.password } : {}),
      PGSSLMODE: input.sslMode === 'disable' ? 'disable' : input.sslMode === 'prefer' ? 'prefer' : 'require',
    },
    outputExtension: 'dump',
    format: 'postgres_custom',
  };
}

export function runDumpCommandStream(command: DumpCommand): DumpStreamRunResult {
  if (Bun.env.BACKUP_FAKE_DUMP_ERROR !== undefined) {
    const message = sanitizeConnectionError(new Error(Bun.env.BACKUP_FAKE_DUMP_ERROR));
    return {
      stream: new ReadableStream({ start(controller) { controller.error(new Error(message)); } }),
      processDone: Promise.resolve(1),
      stderr: Promise.resolve(message),
    };
  }

  if (Bun.env.BACKUP_FAKE_DUMP_OUTPUT !== undefined) {
    const bytes = new TextEncoder().encode(Bun.env.BACKUP_FAKE_DUMP_OUTPUT);
    return { stream: new Response(bytes).body!, processDone: Promise.resolve(0), stderr: Promise.resolve('') };
  }

  const proc = Bun.spawn([command.command, ...command.args], {
    env: { ...Bun.env, ...command.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (!command.gzipOutput) {
    return { stream: proc.stdout, processDone: proc.exited, stderr: new Response(proc.stderr).text() };
  }

  const gzip = Bun.spawn([Bun.env.BACKUP_GZIP_COMMAND ?? 'gzip', '-c'], {
    stdin: proc.stdout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = Promise.all([new Response(proc.stderr).text(), new Response(gzip.stderr).text()]).then(([dumpStderr, gzipStderr]) => [dumpStderr, gzipStderr].filter(Boolean).join('\n'));
  const processDone = Promise.all([proc.exited, gzip.exited]).then(([dumpExit, gzipExit]) => (dumpExit === 0 && gzipExit === 0 ? 0 : dumpExit || gzipExit));
  return { stream: gzip.stdout, processDone, stderr };
}

export async function runDumpCommand(command: DumpCommand): Promise<DumpRunResult> {
  if (Bun.env.BACKUP_FAKE_DUMP_ERROR !== undefined) {
    throw new Error(sanitizeConnectionError(new Error(Bun.env.BACKUP_FAKE_DUMP_ERROR)));
  }

  if (Bun.env.BACKUP_FAKE_DUMP_OUTPUT !== undefined) {
    const bytes = new TextEncoder().encode(Bun.env.BACKUP_FAKE_DUMP_OUTPUT);
    return { bytes, originalSizeBytes: bytes.byteLength };
  }

  const proc = Bun.spawn([command.command, ...command.args], {
    env: { ...Bun.env, ...command.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(sanitizeConnectionError(new Error(stderr || `${command.command} exited with code ${exitCode}`)));
  }

  const rawBytes = new Uint8Array(stdout);
  const bytes = command.gzipOutput ? await gzipBytes(rawBytes) : rawBytes;
  return { bytes, originalSizeBytes: rawBytes.byteLength };
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn([Bun.env.BACKUP_GZIP_COMMAND ?? 'gzip', '-c'], {
    stdin: new Response(bytes).body,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(sanitizeConnectionError(new Error(stderr || 'gzip failed')));
  return new Uint8Array(stdout);
}

export function safeDumpCommandForLog(command: DumpCommand) {
  return {
    command: command.command,
    args: command.args,
    env: Object.fromEntries(Object.keys(command.env).map((key) => [key, '[REDACTED]'])),
    outputExtension: command.outputExtension,
    format: command.format,
    gzipOutput: command.gzipOutput ?? false,
  };
}

export function sanitizeConnectionError(error: unknown): string {
  if (!(error instanceof Error)) return 'Connection test failed';
  return error.message
    .replace(/password=[^\s]+/gi, 'password=REDACTED')
    .replace(/:[^:@\s]+@/g, ':REDACTED@')
    .replace(/(pass(word)?\s*[:=]\s*)[^\s]+/gi, '$1REDACTED');
}

function validateConnectionPayload(input: ConnectionTestInput): string | null {
  if (!['mysql', 'postgresql'].includes(input.engine)) return 'Unsupported database engine';
  if (!input.host.trim()) return 'Database host is required';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'Database port is invalid';
  if (!input.database.trim()) return 'Database name is required';
  if (!input.username.trim()) return 'Database username is required';
  return null;
}

function failed(userErrorMessage: string): ConnectionTestResult {
  return {
    ok: false,
    server_version: null,
    tls: 'unknown',
    can_dump: false,
    user_error_message: userErrorMessage,
  };
}
