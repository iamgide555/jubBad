#!/usr/bin/env node
/**
 * Consistent, online backup of the SQLite database.
 *
 * Copying `dev.db` is not a backup. The database runs in WAL mode
 * (`PrismaService.onModuleInit`), so committed writes live in `dev.db-wal`
 * until a checkpoint folds them back; copying the three files is also a torn
 * read, because they are read at three different instants while the API keeps
 * writing. SQLite's online backup API takes a consistent snapshot while the
 * server carries on serving, which is the whole point — a badminton session
 * should never have to stop for a backup.
 *
 * The result is a single self-contained `.db` file with no sidecars, so
 * restoring is a file move rather than a procedure.
 *
 * Usage:
 *   node scripts/backup-db.mjs [--out <dir>] [--keep <days>] [--min-keep <n>]
 *
 * Defaults: --out <db dir>/backups, --keep 30, --min-keep 7.
 */
import { createRequire } from 'node:module';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const args = { out: null, keep: 30, minKeep: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out') {
      args.out = value;
      i += 1;
    } else if (flag === '--keep') {
      args.keep = Number(value);
      i += 1;
    } else if (flag === '--min-keep') {
      args.minKeep = Number(value);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!Number.isFinite(args.keep) || args.keep < 1) {
    throw new Error('--keep must be a positive number of days');
  }
  if (!Number.isFinite(args.minKeep) || args.minKeep < 1) {
    throw new Error('--min-keep must be a positive count');
  }
  return args;
}

/**
 * `DATABASE_URL` is a Prisma URL (`file:/app/prisma/dev.db`), not a path, and
 * it is the same value the running server uses — deriving the path from it is
 * what guarantees the backup is of the database actually in use rather than of
 * a stale copy someone left in the repo.
 */
export function databasePath(url = process.env.DATABASE_URL, cwd = process.cwd()) {
  if (!url) {
    throw new Error('DATABASE_URL is not set — run this from the server directory or container.');
  }
  if (!url.startsWith('file:')) {
    throw new Error(`DATABASE_URL must be a file: URL for backups, got "${url}"`);
  }
  return path.resolve(cwd, url.slice('file:'.length));
}

/** Sortable, filename-safe, and unambiguous about which run produced it. */
export function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Retention deletes by age but never below `minKeep` files. Age alone is a
 * trap: if the scheduler stops running, every backup eventually ages out and
 * the retention job quietly deletes the last copy of the data it exists to
 * protect.
 */
export function backupsToDelete(files, { keepDays, minKeep, now }) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  return sorted.slice(minKeep).filter((file) => file.mtimeMs < cutoff);
}

export function isBackupFile(name) {
  return name.startsWith('jubbad-') && name.endsWith('.db');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = databasePath();
  const outDir = path.resolve(
    process.cwd(),
    args.out ?? path.join(path.dirname(source), 'backups')
  );
  await mkdir(outDir, { recursive: true });

  const target = path.join(outDir, `jubbad-${timestamp()}.db`);

  const Database = require('better-sqlite3');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  // A backup nobody has read is a guess. Verifying here makes a corrupt
  // snapshot a loud failure tonight, rather than a discovery during a restore
  // — which is the worst possible moment to find out.
  const check = new Database(target, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup failed integrity_check: ${result}`);
  } finally {
    check.close();
  }

  console.log(`Backup written: ${target} (${(await stat(target)).size} bytes, integrity_check ok)`);

  const entries = await readdir(outDir);
  const backups = await Promise.all(
    entries.filter(isBackupFile).map(async (name) => {
      const full = path.join(outDir, name);
      return { path: full, mtimeMs: (await stat(full)).mtimeMs };
    })
  );
  const stale = backupsToDelete(backups, {
    keepDays: args.keep,
    minKeep: args.minKeep,
    now: Date.now(),
  });
  for (const file of stale) {
    await rm(file.path);
    console.log(`Pruned: ${file.path}`);
  }
  console.log(`Retained ${backups.length - stale.length} backup(s) in ${outDir}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
