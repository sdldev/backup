export type FakeDumpEngine = "postgresql" | "mysql";

export type FakeDumpProcess = {
  engine: FakeDumpEngine;
  command: string[];
  stdout: Uint8Array;
  exitCode: number;
};

export function createFakeDumpProcess(engine: FakeDumpEngine, sourceLabel: string): FakeDumpProcess {
  const stdoutText = `-- fake ${engine} dump for ${sourceLabel}\ncreate table backups(id uuid primary key);\n`;

  return {
    engine,
    command:
      engine === "postgresql"
        ? ["pg_dump", "-Fc", sourceLabel]
        : ["mysqldump", "--single-transaction", "--routines", "--triggers", "--events", sourceLabel],
    stdout: new TextEncoder().encode(stdoutText),
    exitCode: 0
  };
}
