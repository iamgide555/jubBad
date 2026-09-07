import { describe, expect, it } from 'vitest';
import { backupsToDelete, databasePath, isBackupFile, parseArgs, timestamp } from './backup-db.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

function file(name: string, ageDays: number) {
  return { path: `/backups/${name}`, mtimeMs: NOW - ageDays * DAY };
}

describe('backup retention', () => {
  it('deletes only backups older than the retention window', () => {
    const files = [file('a.db', 1), file('b.db', 40), file('c.db', 31), file('d.db', 3)];
    const stale = backupsToDelete(files, { keepDays: 30, minKeep: 1, now: NOW });
    expect(stale.map((f) => f.path)).toEqual(['/backups/c.db', '/backups/b.db']);
  });

  /**
   * The failure this guards against is not hypothetical: if the scheduler
   * stops, every backup keeps ageing, and an age-only rule would eventually
   * delete the last copy of the data it exists to protect — leaving nothing,
   * silently, with no error anywhere.
   */
  it('keeps the newest few even when every backup has aged out', () => {
    const files = [file('a.db', 100), file('b.db', 200), file('c.db', 300)];
    const stale = backupsToDelete(files, { keepDays: 30, minKeep: 7, now: NOW });
    expect(stale).toEqual([]);
  });

  it('prunes oldest-first once the floor is satisfied', () => {
    const files = [file('new.db', 1), file('mid.db', 60), file('old.db', 90)];
    const stale = backupsToDelete(files, { keepDays: 30, minKeep: 2, now: NOW });
    expect(stale.map((f) => f.path)).toEqual(['/backups/old.db']);
  });

  it('never deletes a fresh backup just because the floor is exceeded', () => {
    const files = [file('a.db', 0), file('b.db', 1), file('c.db', 2)];
    expect(backupsToDelete(files, { keepDays: 30, minKeep: 1, now: NOW })).toEqual([]);
  });
});

describe('backup arguments and paths', () => {
  it('defaults to a 30-day window with a floor of 7', () => {
    expect(parseArgs([])).toEqual({ out: null, keep: 30, minKeep: 7 });
  });

  it('rejects nonsense retention rather than silently keeping nothing', () => {
    expect(() => parseArgs(['--keep', '0'])).toThrow(/positive number of days/);
    expect(() => parseArgs(['--min-keep', 'abc'])).toThrow(/positive count/);
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown argument/);
  });

  it('reads the database location from the URL the server itself uses', () => {
    expect(databasePath('file:/app/prisma/dev.db', '/app')).toBe('/app/prisma/dev.db');
    expect(databasePath('file:./prisma/dev.db', '/repo/server')).toBe('/repo/server/prisma/dev.db');
  });

  it('refuses a non-file datasource instead of backing up nothing', () => {
    expect(() => databasePath('postgresql://host/db', '/app')).toThrow(/must be a file:/);
    expect(() => databasePath('', '/app')).toThrow(/DATABASE_URL is not set/);
  });

  it('names backups so they sort chronologically and survive any filesystem', () => {
    const name = `jubbad-${timestamp(new Date(NOW))}.db`;
    expect(name).toBe('jubbad-2026-09-07T12-00-00-000Z.db');
    expect(isBackupFile(name)).toBe(true);
    // Retention must not reach outside its own files — the aside copy a
    // restore leaves behind is exactly what someone would want back.
    expect(isBackupFile('dev.db')).toBe(false);
    expect(isBackupFile('dev.db.replaced-2026-09-07T12-00-00-000Z')).toBe(false);
  });
});
