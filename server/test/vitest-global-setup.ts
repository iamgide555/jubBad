import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Every suite gets an isolated, migrated SQLite database. Test modules load
 * dotenv themselves, but dotenv never overwrites this explicit environment
 * value, so no test can fall back to a developer's local application data.
 */
export default function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'jubbad-vitest-'));
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;

  execFileSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: process.cwd(), env: process.env, stdio: 'pipe' }
  );

  return () => rmSync(directory, { recursive: true, force: true });
}
