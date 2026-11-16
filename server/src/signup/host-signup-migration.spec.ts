import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Applies the REAL migration files to a throwaway database holding what a deployed one has (a host who owns a group and
 * has a password-reset token), then the host_signup migration inside a transaction with foreign keys ON: the harshest
 * way a runner can apply it. A rebuild of the "User" table cascades from DROP TABLE there and silently clears every
 * Group.ownerId and deletes the reset tokens, so this migration must add its column in place.
 */
describe('host_signup migration', () => {
  const migrations = join(process.cwd(), 'prisma', 'migrations');
  const dirs = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const signupDir = dirs.find((d) => d.endsWith('_host_signup'))!;
  const sql = readFileSync(join(migrations, signupDir, 'migration.sql'), 'utf8');
  let dir: string;
  let db: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-signup-mig-'));
    db = new Database(join(dir, 'legacy.db'));
    for (const d of dirs.filter((x) => x < signupDir)) db.exec(readFileSync(join(migrations, d, 'migration.sql'), 'utf8'));
    db.exec(`INSERT INTO "User" (id, email, passwordHash, role, plan, lineUserId) VALUES ('u1', 'a@example.test', 'x', 'host', 'host', 'U1')`);
    db.exec(`INSERT INTO "Group" (code, name, ownerId) VALUES ('g1', 'One', 'u1')`);
    db.exec(`INSERT INTO "PasswordReset" (id, userId, tokenHash, expiresAt) VALUES ('r1', 'u1', 'h1', '2030-01-01T00:00:00.000Z')`);

    db.pragma('foreign_keys = ON');
    db.exec('BEGIN');
    db.exec(sql);
    db.exec('COMMIT');
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every group’s owner and every reset token', () => {
    expect(db.prepare(`SELECT ownerId FROM "Group" WHERE code = 'g1'`).get()).toEqual({ ownerId: 'u1' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "PasswordReset"`).get()).toEqual({ n: 1 });
  });

  it('keeps the user as it was and gives them the admin source', () => {
    expect(db.prepare(`SELECT plan, lineUserId, signupSource FROM "User" WHERE id = 'u1'`).get()).toEqual({
      plan: 'host',
      lineUserId: 'U1',
      signupSource: 'admin',
    });
  });

  it('adds the trial table with both unique indexes, and leaves the plan default as club', () => {
    const indexes = (db.prepare(`PRAGMA index_list("TrialRecord")`).all() as { name: string; unique: number }[]).filter((i) => i.unique === 1 && i.name.startsWith('TrialRecord_'));
    expect(indexes.map((i) => i.name).sort()).toEqual(['TrialRecord_lineUserId_key', 'TrialRecord_userId_key']);
    db.exec(`INSERT INTO "User" (id, email, passwordHash) VALUES ('u2', 'b@example.test', 'x')`);
    expect(db.prepare(`SELECT plan FROM "User" WHERE id = 'u2'`).get()).toEqual({ plan: 'club' });
  });

  it('does not rebuild the User table', () => {
    expect(sql).not.toMatch(/DROP TABLE "User"/);
  });
});
