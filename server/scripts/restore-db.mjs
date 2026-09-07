#!/usr/bin/env node
/**
 * Restores a backup produced by `backup-db.mjs`.
 *
 * The API must be stopped first (`docker compose stop api`). This script
 * cannot enforce that — SQLite will happily let a second process open the file
 * — so it is stated here and in `dockerDeploy.md`, and the script does the two
 * things that are easy to get wrong by hand:
 *
 *  1. It deletes `-wal` and `-shm`. Leaving them behind is the classic silent
 *     restore failure: SQLite replays the old journal over the restored file
 *     and you get back some of the data you were trying to discard.
 *  2. It moves the current database aside instead of overwriting it, so a
 *     restore from the wrong backup is itself recoverable. That file is the
 *     one thing you cannot make another copy of once it is gone.
 *
 * Usage:
 *   node scripts/restore-db.mjs <backup.db>
 */
import { createRequire } from 'node:module';
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { databasePath, timestamp } from './backup-db.mjs';

const require = createRequire(import.meta.url);

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [source] = process.argv.slice(2);
  if (!source) throw new Error('Usage: node scripts/restore-db.mjs <backup.db>');
  const backup = path.resolve(process.cwd(), source);
  if (!(await exists(backup))) throw new Error(`No such backup: ${backup}`);

  const Database = require('better-sqlite3');
  const check = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Refusing to restore a corrupt backup: ${result}`);
  } finally {
    check.close();
  }

  const target = databasePath();
  if (await exists(target)) {
    const aside = `${target}.replaced-${timestamp()}`;
    await rename(target, aside);
    console.log(`Current database moved aside: ${aside}`);
  }
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (await exists(sidecar)) {
      await rm(sidecar);
      console.log(`Removed stale journal: ${sidecar}`);
    }
  }

  await copyFile(backup, target);
  console.log(`Restored ${backup} -> ${target}`);
  console.log('Start the API again (docker compose start api) and check a recent session.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
