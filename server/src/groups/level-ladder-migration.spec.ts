import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { asLevel, seedFor } from '../../../engines/levels.ts';

/**
 * Applies the REAL migration files, in order, to a throwaway database, with
 * rows inserted at the point just before the ladder migration: the legacy
 * fixture a deployed database looks like. Proves the backfill freezes exactly
 * what the old name-derived anchor produced, and keeps levelSetAt as it was.
 */
describe('level ladder migration (level seed backfill)', () => {
  const migrations = join(process.cwd(), 'prisma', 'migrations');
  const dirs = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const ladderDir = dirs.find((d) => d.endsWith('_group_level_ladders'))!;
  let dir: string;
  let db: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ladder-mig-'));
    db = new Database(join(dir, 'legacy.db'));
    for (const d of dirs.filter((x) => x < ladderDir)) db.exec(readFileSync(join(migrations, d, 'migration.sql'), 'utf8'));
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('freezes each legacy player at their old derived anchor and leaves levelSetAt untouched', () => {
    db.exec(`INSERT INTO "Group" (code, name) VALUES ('g1', 'Legacy')`);
    const rows: [string, string | null, string | null][] = [
      ['bg', 'BG', null], ['n', 'N', null], ['p', 'P', '2026-09-20T00:00:00.000Z'], ['b', 'B', null],
      ['cleared', null, '2026-09-21T00:00:00.000Z'], ['never', null, null], ['odd', 'ZZ', null],
    ];
    for (const [id, level, setAt] of rows) {
      db.prepare(`INSERT INTO "Player" (id, groupId, name, aliases, level, levelSetAt) VALUES (?, 'g1', ?, '[]', ?, ?)`).run(id, id, level, setAt);
    }
    db.exec(readFileSync(join(migrations, ladderDir, 'migration.sql'), 'utf8'));

    const after = db.prepare(`SELECT id, level, levelSeed, levelSetAt FROM "Player"`).all() as { id: string; level: string | null; levelSeed: number; levelSetAt: string | null }[];
    for (const p of after) {
      expect(p.levelSeed, p.id).toBe(seedFor(asLevel(p.level)));
      const original = rows.find((r) => r[0] === p.id)!;
      expect(p.levelSetAt).toBe(original[2]);
    }
    expect(after.find((p) => p.id === 'bg')!.levelSeed).toBe(900);
    expect(after.find((p) => p.id === 'p')!.levelSeed).toBe(1300);
    expect(after.find((p) => p.id === 'cleared')!.levelSeed).toBe(1200);
    expect(after.find((p) => p.id === 'never')!.levelSeed).toBe(1200);
    expect(after.find((p) => p.id === 'odd')!.levelSeed).toBe(1200);
  });

  it('adds the group columns with a null ladder and revision 0 for existing groups', () => {
    const g = db.prepare(`SELECT levelLadder, levelLadderRevision FROM "Group" WHERE code = 'g1'`).get() as { levelLadder: string | null; levelLadderRevision: number };
    expect(g).toEqual({ levelLadder: null, levelLadderRevision: 0 });
  });

  it('does not rebuild the Group table, so columns added by other migrations survive', () => {
    expect(readFileSync(join(migrations, ladderDir, 'migration.sql'), 'utf8')).not.toMatch(/new_Group|DROP TABLE/i);
  });
});
