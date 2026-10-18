import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { backfillVenues } from './backfill.js';

/**
 * The one-off, owner-scoped link of old sessions to the shared venue list.
 * Group names and venue names carry a per-run suffix so rows left by other
 * specs or dev data never collide with these.
 */
describe('backfillVenues', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  const run = randomUUID().slice(0, 8);
  const mamaGroup = `Bad@Mama${run}`;
  const thuGroup = `วันพฤหัส${run}`;
  const mamaVenue = `Mama Badminton${run}`;
  const kipVenue = `KIP Complex${run}`;
  const mapping = [
    { groupName: mamaGroup, venueName: mamaVenue },
    { groupName: thuGroup, venueName: kipVenue },
  ];

  let hostA: { id: string; email: string };
  let hostB: { id: string; email: string };
  const groups: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
    const mk = (tag: string) =>
      prisma.user.create({ data: { email: `backfill-${tag}-${run}@example.test`, passwordHash: 'x' } });
    hostA = await mk('a');
    hostB = await mk('b');
  });

  afterEach(async () => {
    await prisma.session.deleteMany({ where: { groupId: { in: groups } } });
    await prisma.group.deleteMany({ where: { code: { in: groups } } });
    groups.length = 0;
    await prisma.venue.deleteMany({ where: { normalizedName: { contains: run } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [hostA.id, hostB.id] } } });
    await close();
  });

  async function group(name: string, ownerId: string | null, venues: (string | null)[]) {
    const code = randomUUID();
    groups.push(code);
    await prisma.group.create({ data: { code, name, ownerId } });
    const codes: string[] = [];
    for (const venue of venues) {
      const session = await prisma.session.create({
        data: { code: randomUUID().slice(0, 12), groupId: code, venue, rawImportText: '' },
      });
      codes.push(session.code);
    }
    return { code, sessions: codes };
  }

  const sessionsOf = (groupCode: string) =>
    prisma.session.findMany({ where: { groupId: groupCode }, orderBy: { code: 'asc' } });

  async function seedWorld() {
    return {
      mama: await group(mamaGroup, hostA.id, [null, 'Gym', '']),
      thu: await group(` ${thuGroup.toLowerCase()} `.replace(run, run), hostA.id, ['kip', null]),
      other: await group(`Other${run}`, hostA.id, [`KIP${run}`, `kip${run} `, '']),
      bMama: await group(mamaGroup, hostB.id, [null, 'Gym']),
      ownerless: await group(mamaGroup, null, [null]),
    };
  }

  const options = (dryRun = false) => ({ ownerEmail: hostA.email, groupVenues: mapping, dryRun });

  it('sets every session in a mapped group to its venue, overwriting the old text', async () => {
    const world = await seedWorld();
    const report = await backfillVenues(prisma, options());

    const mamaRow = await prisma.venue.findUniqueOrThrow({
      where: { normalizedName: mamaVenue.toLowerCase().replace(/\s+/g, '') },
    });
    const kipRow = await prisma.venue.findUniqueOrThrow({
      where: { normalizedName: kipVenue.toLowerCase().replace(/\s+/g, '') },
    });
    expect(mamaRow.displayName).toBe(mamaVenue);

    for (const s of await sessionsOf(world.mama.code)) {
      expect(s.venueId).toBe(mamaRow.id);
      expect(s.venue).toBe(mamaVenue);
    }
    for (const s of await sessionsOf(world.thu.code)) {
      expect(s.venueId).toBe(kipRow.id);
      expect(s.venue).toBe(kipVenue);
    }
    expect(report).toEqual({
      ownerFound: true,
      venuesCreated: 2,
      venuesReused: 0,
      sessionsLinked: 5,
      sessionTextsOverwritten: 5,
      unmatchedGroupNames: [],
      dryRun: false,
    });
  });

  it("leaves the owner's other groups, other hosts' groups and ownerless groups untouched", async () => {
    const world = await seedWorld();
    await backfillVenues(prisma, options());

    const untouched = {
      other: [`KIP${run}`, `kip${run} `, ''],
      bMama: [null, 'Gym'],
      ownerless: [null],
    } as const;
    for (const key of ['other', 'bMama', 'ownerless'] as const) {
      const rows = await sessionsOf(world[key].code);
      expect(rows.map((r) => r.venueId)).toEqual(rows.map(() => null));
      expect(rows.map((r) => r.venue).sort()).toEqual([...untouched[key]].sort());
    }
  });

  it('counts a re-run as no change, and reuses a venue that already exists', async () => {
    await seedWorld();
    await backfillVenues(prisma, options());
    const again = await backfillVenues(prisma, options());
    expect(again).toMatchObject({ venuesCreated: 0, sessionsLinked: 0, sessionTextsOverwritten: 0 });
    expect(await prisma.venue.count({ where: { normalizedName: { contains: run } } })).toBe(2);
  });

  it('links to an existing venue with the same normalized name rather than creating one', async () => {
    await prisma.venue.create({
      data: { displayName: mamaVenue.toUpperCase(), normalizedName: mamaVenue.toLowerCase().replace(/\s+/g, '') },
    });
    await seedWorld();
    const report = await backfillVenues(prisma, options());
    expect(report.venuesCreated).toBe(1);
    expect(report.venuesReused).toBe(1);
  });

  it('writes nothing on a dry run but reports the counts a real run produces', async () => {
    await seedWorld();
    const dry = await backfillVenues(prisma, options(true));
    expect(await prisma.venue.count({ where: { normalizedName: { contains: run } } })).toBe(0);
    expect(await prisma.session.count({ where: { venueId: { not: null }, groupId: { in: groups } } })).toBe(0);
    const real = await backfillVenues(prisma, options());
    expect(dry).toEqual({ ...real, dryRun: true });
  });

  it('lists a mapped group name the owner does not have, without throwing', async () => {
    await group(mamaGroup, hostA.id, [null]);
    const report = await backfillVenues(prisma, options(true));
    expect(report.unmatchedGroupNames).toEqual([thuGroup]);
  });

  it('matches the owner email and group names ignoring case and surrounding spaces', async () => {
    await group(`  ${mamaGroup.toUpperCase()}  `, hostA.id, [null]);
    const report = await backfillVenues(prisma, {
      ownerEmail: hostA.email.toUpperCase(),
      groupVenues: [{ groupName: mamaGroup, venueName: mamaVenue }],
      dryRun: false,
    });
    expect(report).toMatchObject({ ownerFound: true, sessionsLinked: 1, unmatchedGroupNames: [] });
  });

  it('rejects an unknown owner email', async () => {
    await expect(
      backfillVenues(prisma, { ownerEmail: `nobody-${run}@example.test`, groupVenues: mapping, dryRun: false })
    ).rejects.toThrow(`owner not found: nobody-${run}@example.test`);
  });

  it('rejects a mapping whose venue name is blank', async () => {
    await expect(
      backfillVenues(prisma, {
        ownerEmail: hostA.email,
        groupVenues: [{ groupName: mamaGroup, venueName: '   ' }],
        dryRun: false,
      })
    ).rejects.toThrow(/blank venue name/);
  });
});
