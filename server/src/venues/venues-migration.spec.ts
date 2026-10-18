import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

it('adds Venue and a nullable Session.venueId without backfilling or disturbing sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'venues-migration-'));
  const db = new Database(join(directory, 'legacy.db'));
  try {
    const path = join(process.cwd(), 'prisma/migrations');
    const migration = '20261018000000_shared_venues';
    for (const name of readdirSync(path).filter((n) => n < migration && n !== 'migration_lock.toml').sort()) {
      db.exec(readFileSync(join(path, name, 'migration.sql'), 'utf8'));
    }
    db.exec(`INSERT INTO "Group" (code) VALUES ('legacy');
      INSERT INTO "Session" (code, groupId, venue, rawImportText) VALUES ('a', 'legacy', 'KIP', ''), ('b', 'legacy', NULL, '');`);
    const before = db.prepare('SELECT * FROM "Session" ORDER BY code').all();

    db.exec(readFileSync(join(path, migration, 'migration.sql'), 'utf8'));

    expect(db.prepare('SELECT * FROM "Session" ORDER BY code').all()).toEqual(
      (before as object[]).map((row) => ({ ...row, venueId: null }))
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM "Venue"').get()).toEqual({ n: 0 });

    db.exec(`INSERT INTO "Venue" (id, displayName, normalizedName) VALUES ('v1', 'KIP', 'kip')`);
    expect(() =>
      db.exec(`INSERT INTO "Venue" (id, displayName, normalizedName) VALUES ('v2', 'K I P', 'kip')`)
    ).toThrow(/UNIQUE/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
