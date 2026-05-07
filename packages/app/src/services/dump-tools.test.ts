import { describe, expect, test } from 'bun:test';

async function commandExists(command: string) {
  const result = Bun.spawnSync(['sh', '-lc', `command -v ${command}`]);
  return result.exitCode === 0;
}

const shouldRun = Bun.env.CHECK_DUMP_TOOLS === 'true';

describe.skipIf(!shouldRun)('Backup dump toolchain', () => {
  test('required dump tools are present in runtime image or local dev shell', async () => {
    const missing = [];
    for (const command of ['pg_dump', 'mysqldump', 'gzip']) {
      if (!(await commandExists(command))) missing.push(command);
    }
    expect(missing).toEqual([]);
  });
});
