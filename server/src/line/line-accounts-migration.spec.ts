import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Applies the REAL migration files, in order, to a throwaway database, with legacy LINE rows inserted just before
 * the line-accounts migration: what a deployed database looks like. Proves the backfill builds the account directory
 * from every table that already knew a LINE user, and that every existing player link survives the rebuild.
 */
describe('line accounts migration (directory backfill)', () => {
  const migrations = join(process.cwd(), 'prisma', 'migrations');
  const dirs = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const accountsDir = dirs.find((d) => d.endsWith('_line_accounts'))!;
  let dir: string;
  let db: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'line-accounts-mig-'));
    db = new Database(join(dir, 'legacy.db'));
    for (const d of dirs.filter((x) => x < accountsDir)) db.exec(readFileSync(join(migrations, d, 'migration.sql'), 'utf8'));

    db.exec(`INSERT INTO "Group" (code, name) VALUES ('g1', 'One'), ('g2', 'Two')`);
    db.exec(`INSERT INTO "Player" (id, groupId, name, aliases) VALUES ('p1', 'g1', 'P1', '[]'), ('p2', 'g1', 'P2', '[]')`);
    db.exec(`INSERT INTO "Session" (code, groupId, rawImportText) VALUES ('s1', 'g1', '')`);
    db.exec(`INSERT INTO "PlayerLineAccount" (id, groupId, playerId, lineUserId, displayName, linkedBy, createdAt)
             VALUES ('l1', 'g1', 'p1', 'U1', 'Old', 'self', '2026-10-01T10:00:00.000Z')`);
    db.exec(`INSERT INTO "PendingSlip" (id, sessionId, groupId, reference, lineUserId, displayName, pictureUrl, reason, createdAt) VALUES
             ('ps1', 's1', 'g1', 'r1', 'U1', 'Slip', 'https://x/1', 'unmapped', '2026-10-05T10:00:00.000Z'),
             ('ps2', 's1', 'g1', 'r2', 'U2', 'Two', NULL, 'unmapped', '2026-10-03T10:00:00.000Z')`);
    db.exec(`INSERT INTO "LineRosterMessage" (id, groupId, text, senderUserId, senderName, postedAt, lineMessageId, direct, createdAt) VALUES
             ('m1', 'g2', '1. a', 'U1', 'Roster', '2026-10-02T10:00:00.000Z', 'lm1', 0, '2026-10-02T10:00:01.000Z'),
             ('m2', 'g1', '1. a', 'U9', 'Direct', '2026-10-04T10:00:00.000Z', 'lm2', 1, '2026-10-04T10:00:01.000Z')`);

    db.exec(readFileSync(join(migrations, accountsDir, 'migration.sql'), 'utf8'));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type Account = { id: string; lineUserId: string; displayName: string | null; pictureUrl: string | null };
  const accounts = () => db.prepare(`SELECT id, lineUserId, displayName, pictureUrl FROM "LineAccount" ORDER BY lineUserId`).all() as Account[];

  it('creates one account per LINE user seen in a group, skipping direct-message-only senders', () => {
    expect(accounts().map((a) => a.lineUserId)).toEqual(['U1', 'U2']);
  });

  it('takes the name and picture from a pending slip first, then the link, then the roster sender', () => {
    const [u1, u2] = accounts();
    expect(u1).toMatchObject({ displayName: 'Slip', pictureUrl: 'https://x/1' });
    expect(u2).toMatchObject({ displayName: 'Two', pictureUrl: null });
  });

  it('records each group membership with its first source and first/last seen times', () => {
    const rows = db
      .prepare(
        `SELECT m.groupId, a.lineUserId, m.source, m.firstSeenAt, m.lastSeenAt
         FROM "LineAccountGroup" m JOIN "LineAccount" a ON a.id = m.lineAccountId
         ORDER BY m.groupId, a.lineUserId`
      )
      .all();
    expect(rows).toEqual([
      { groupId: 'g1', lineUserId: 'U1', source: 'claim', firstSeenAt: '2026-10-01T10:00:00.000Z', lastSeenAt: '2026-10-05T10:00:00.000Z' },
      { groupId: 'g1', lineUserId: 'U2', source: 'slip', firstSeenAt: '2026-10-03T10:00:00.000Z', lastSeenAt: '2026-10-03T10:00:00.000Z' },
      { groupId: 'g2', lineUserId: 'U1', source: 'roster', firstSeenAt: '2026-10-02T10:00:00.000Z', lastSeenAt: '2026-10-02T10:00:00.000Z' },
    ]);
  });

  it('keeps every existing player link, now pointing at an account, with no broken foreign keys', () => {
    expect(db.prepare(`SELECT groupId, playerId, lineUserId, linkedBy FROM "PlayerLineAccount"`).all()).toEqual([
      { groupId: 'g1', playerId: 'p1', lineUserId: 'U1', linkedBy: 'self' },
    ]);
    const columns = (db.prepare(`PRAGMA table_info("PlayerLineAccount")`).all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('displayName');
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it('a link to an account cascades away with the account', () => {
    const fk = db.prepare(`PRAGMA foreign_key_list("PlayerLineAccount")`).all() as { table: string; from: string; to: string; on_delete: string }[];
    expect(fk).toContainEqual(expect.objectContaining({ table: 'LineAccount', from: 'lineUserId', to: 'lineUserId', on_delete: 'CASCADE' }));
  });
});
