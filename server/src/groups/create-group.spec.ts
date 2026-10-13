import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

/**
 * POST /groups is the dedicated, name-only way to make a group. The caller is
 * swapped per test through `caller`, standing in for AuthGuard the same way
 * groups.controller.spec.ts does, so these tests stay about creation rules.
 */
describe('POST /groups', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let hostA: string;
  let hostB: string;
  let admin: string;
  let caller: { id: string; role: string };
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const mk = (role: string) =>
      prisma.user.create({ data: { email: `create-group-${role}-${randomUUID()}@example.test`, passwordHash: 'x', role } });
    hostA = (await mk('host')).id;
    hostB = (await mk('host')).id;
    admin = (await mk('admin')).id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = caller;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  beforeEach(() => {
    caller = { id: hostA, role: 'host' };
  });

  afterEach(async () => {
    await prisma.group.deleteMany({ where: { code: { in: codes.splice(0) } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [hostA, hostB, admin] } } });
    await app.close();
  });

  const fresh = () => {
    const code = randomUUID();
    codes.push(code);
    return code;
  };

  it('creates an owned group from a name alone, with default settings and nothing else', async () => {
    const code = fresh();
    const res = await request(server).post('/groups').send({ code, name: 'ก๊วนอังคาร' }).expect(201);
    expect(res.body).toEqual({ code, name: 'ก๊วนอังคาร' });

    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.ownerId).toBe(hostA);
    expect(row.shuttleToolsEnabled).toBe(false);
    expect(row.crossSessionHistory).toBe(false);
    expect(await prisma.session.count({ where: { groupId: code } })).toBe(0);
    expect(await prisma.player.count({ where: { groupId: code } })).toBe(0);
  });

  it('stores the name trimmed', async () => {
    const code = fresh();
    const res = await request(server).post('/groups').send({ code, name: '  แบดเย็น  ' }).expect(201);
    expect(res.body.name).toBe('แบดเย็น');
  });

  it.each([[''], ['   '], [undefined]])('rejects a blank name (%j)', async (name) => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name }).expect(400);
    expect(await prisma.group.count({ where: { code } })).toBe(0);
  });

  it.each([['abcd1234'], ['ABCDEF12-3456-7890-ABCD-EF1234567890'], ['not-a-code'], ['']])(
    'rejects a code that is not a lowercase full UUID (%s)',
    async (code) => {
      await request(server).post('/groups').send({ code, name: 'X' }).expect(400);
    }
  );

  it('returns the same group on a retry, without renaming it or resetting its settings', async () => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name: 'First' }).expect(201);
    await prisma.group.update({ where: { code }, data: { shuttleToolsEnabled: true } });

    const retry = await request(server).post('/groups').send({ code, name: 'Second' }).expect(201);
    expect(retry.body).toEqual({ code, name: 'First' });
    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.name).toBe('First');
    expect(row.shuttleToolsEnabled).toBe(true);
  });

  it('two simultaneous creates with one code leave exactly one group', async () => {
    const code = fresh();
    const [a, b] = await Promise.all([
      request(server).post('/groups').send({ code, name: 'Tap' }),
      request(server).post('/groups').send({ code, name: 'Tap' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await prisma.group.count({ where: { code } })).toBe(1);
  });

  it("404s another host's code and leaves that group untouched", async () => {
    const code = fresh();
    await prisma.group.create({ data: { code, name: 'B owns this', ownerId: hostB } });
    await request(server).post('/groups').send({ code, name: 'Stolen' }).expect(404);
    expect((await prisma.group.findUniqueOrThrow({ where: { code } })).name).toBe('B owns this');
  });

  it("404s an admin's create over a code another host owns — creation never claims", async () => {
    caller = { id: admin, role: 'admin' };
    const code = fresh();
    await prisma.group.create({ data: { code, name: 'B owns this', ownerId: hostB } });
    await request(server).post('/groups').send({ code, name: 'Admin' }).expect(404);
    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.ownerId).toBe(hostB);
    expect(row.name).toBe('B owns this');
  });

  it('ignores an owner supplied in the body', async () => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name: 'Mine', ownerId: hostB }).expect(201);
    expect((await prisma.group.findUniqueOrThrow({ where: { code } })).ownerId).toBe(hostA);
  });
});
