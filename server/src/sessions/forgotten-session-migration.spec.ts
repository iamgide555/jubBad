import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

it('preserves legacy data and multiple open sessions with null recovery fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-migration-'));
  const db = new Database(join(directory, 'legacy.db'));
  try {
    const path = join(process.cwd(), 'prisma/migrations');
    const migration = '20261014000000_forgotten_session_closure';
    for (const name of readdirSync(path).filter(n => n < migration && n !== 'migration_lock.toml').sort()) db.exec(readFileSync(join(path, name, 'migration.sql'), 'utf8'));
    db.exec(`INSERT INTO "Group" (code) VALUES ('legacy');
      INSERT INTO "Session" (code, groupId, rawImportText) VALUES ('old', 'legacy', ''), ('new', 'legacy', '');
      INSERT INTO "Pairing" (id, sessionId, courtNumber, matchNumber, teamA, teamB, confirmedAt, endedAt, winner)
      VALUES ('played', 'old', 1, 1, '["a","b"]', '["c","d"]', 0, 900000, 'A');`);
    const before = db.prepare('SELECT * FROM Pairing').get();
    db.exec(readFileSync(join(path, migration, 'migration.sql'), 'utf8'));
    expect(db.prepare('SELECT * FROM Pairing').get()).toEqual({ ...(before as object), closedWithoutResultAt: null, estimatedDurationSeconds: null });
    expect(db.prepare('SELECT code, endedAt, closedAsForgottenAt FROM Session ORDER BY code').all()).toEqual([
      { code: 'new', endedAt: null, closedAsForgottenAt: null }, { code: 'old', endedAt: null, closedAsForgottenAt: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
