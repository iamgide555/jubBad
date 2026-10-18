import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VenuesModule } from './venues.module.js';
import { VenuesService } from './venues.service.js';

/**
 * The shared venue list. Names carry a per-run suffix so rows left by other
 * specs or dev data never collide with these.
 */
describe('venues', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let venues: VenuesService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const run = randomUUID().slice(0, 8);
  const name = (base: string) => `${base}${run}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, VenuesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    venues = app.get(VenuesService);
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await prisma.venue.deleteMany({ where: { normalizedName: { contains: run } } });
  });

  afterAll(async () => {
    await app.close();
  });

  const seed = (displayName: string) =>
    prisma.venue.create({
      data: { displayName, normalizedName: displayName.toLowerCase().replace(/\s+/g, '') },
    });

  describe('GET /venues/search', () => {
    it('returns an exact normalized match as exact, with no suggestions repeating it', async () => {
      const kip = await seed(name('KIP'));
      const res = await request(server)
        .get('/venues/search')
        .query({ q: ` ${name('kip')} ` })
        .expect(200);
      expect(res.body).toEqual({ exact: { id: kip.id, displayName: kip.displayName }, suggestions: [] });
    });

    it('returns a partial name as a suggestion, never as exact', async () => {
      const kip = await seed(name('KIP'));
      const res = await request(server).get('/venues/search').query({ q: `ki` }).expect(200);
      expect(res.body.exact).toBeNull();
      expect(res.body.suggestions.map((v: { id: string }) => v.id)).toContain(kip.id);
    });

    it.each([['%20%20'], ['']])('returns nothing for a blank query (%j)', async (q) => {
      await seed(name('KIP'));
      const res = await request(server).get(`/venues/search?q=${q}`).expect(200);
      expect(res.body).toEqual({ exact: null, suggestions: [] });
    });

    it('returns nothing when q is missing', async () => {
      const res = await request(server).get('/venues/search').expect(200);
      expect(res.body).toEqual({ exact: null, suggestions: [] });
    });

    it('exposes only id and displayName', async () => {
      await seed(name('KIP'));
      const res = await request(server).get('/venues/search').query({ q: name('kip') }).expect(200);
      expect(Object.keys(res.body.exact).sort()).toEqual(['displayName', 'id']);
    });
  });

  describe('findOrCreate', () => {
    it('returns the existing venue for a name that differs only by case and spaces', async () => {
      const kip = await seed(name('KIP'));
      const id = await venues.findOrCreate(prisma, ` ${name('k i p').replace(run, run.toUpperCase())} `);
      // run is hex, so upper-casing it still normalizes to the same name.
      expect(id).toBe(kip.id);
      expect(await prisma.venue.count({ where: { normalizedName: { contains: run } } })).toBe(1);
    });

    it('creates a venue with the trimmed text as its display name', async () => {
      const id = await venues.findOrCreate(prisma, `  ${name('Mama Badminton')}  `);
      const row = await prisma.venue.findUniqueOrThrow({ where: { id: id! } });
      expect(row.displayName).toBe(name('Mama Badminton'));
      expect(row.normalizedName).toBe(name('mamabadminton'));
    });

    it('converges two concurrent creators of a brand-new venue on one row', async () => {
      const [a, b] = await Promise.all([
        venues.findOrCreate(prisma, name('Race Court')),
        venues.findOrCreate(prisma, name('race court')),
      ]);
      expect(a).toBe(b);
      expect(await prisma.venue.count({ where: { normalizedName: { contains: run } } })).toBe(1);
    });

    it.each([['   '], [''], [null], [undefined]])('returns null for a blank or omitted name (%j)', async (raw) => {
      expect(await venues.findOrCreate(prisma, raw)).toBeNull();
      expect(await prisma.venue.count({ where: { normalizedName: { contains: run } } })).toBe(0);
    });
  });
});
