import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from '../groups/groups.module.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('group limit per plan', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let caller: { id: string; role: string };
  const tag = randomUUID();
  const userIds: string[] = [];

  async function makeUser(
    label: string,
    data: { role?: string; plan?: string; planRenewsAt?: Date | null },
    groups: number
  ) {
    const user = await prisma.user.create({
      data: { email: `limit-${label}-${tag}@example.test`, passwordHash: 'test', role: 'host', ...data },
    });
    userIds.push(user.id);
    const codes: string[] = [];
    for (let i = 0; i < groups; i++) {
      const code = `limit-${label}-${i}-${tag}`;
      codes.push(code);
      await prisma.group.create({ data: { code, name: `G${i}`, ownerId: user.id } });
    }
    return { user, codes };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = caller;
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  const post = (code: string, name = 'New') => request(server).post('/groups').send({ code, name });

  it('refuses a free host with one group a second, with limit 1', async () => {
    const { user, codes } = await makeUser('free', { plan: 'free' }, 1);
    caller = { id: user.id, role: 'host' };
    const res = await post(randomUUID());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'GROUP_LIMIT', limit: 1 });

    // A retry on the existing own code is never refused, and leaves it unchanged.
    const retry = await post(codes[0], 'Renamed');
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ code: codes[0], name: 'G0' });
  });

  it('refuses a free host parsing into a new code, but not into their own', async () => {
    const { user, codes } = await makeUser('freeparse', { plan: 'free' }, 1);
    caller = { id: user.id, role: 'host' };
    const fresh = randomUUID();
    const res = await request(server).post(`/groups/${fresh}/parse`).send({ rawText: 'x', groupName: 'N' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'GROUP_LIMIT', limit: 1 });
    expect(await prisma.group.findUnique({ where: { code: fresh } })).toBeNull();

    await request(server).post(`/groups/${codes[0]}/parse`).send({ rawText: 'x' }).expect(201);
  });

  it('lets a free host with no groups create one', async () => {
    const { user } = await makeUser('zero', { plan: 'free' }, 0);
    caller = { id: user.id, role: 'host' };
    await post(randomUUID()).expect(201);
  });

  it('allows a host plan three groups and refuses a fourth with limit 3', async () => {
    const { user } = await makeUser('host', { plan: 'host' }, 2);
    caller = { id: user.id, role: 'host' };
    await post(randomUUID()).expect(201);
    const res = await post(randomUUID());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'GROUP_LIMIT', limit: 3 });
  });

  it('allows a club plan a fourth group', async () => {
    const { user } = await makeUser('club', { plan: 'club' }, 3);
    caller = { id: user.id, role: 'host' };
    await post(randomUUID()).expect(201);
  });

  it('has no limit for an admin caller', async () => {
    const { user } = await makeUser('admin', { plan: 'free' }, 12);
    caller = { id: user.id, role: 'admin' };
    await post(randomUUID()).expect(201);
    await request(server).post(`/groups/${randomUUID()}/parse`).send({ rawText: 'x' }).expect(201);
  });

  it('reads a lapsed host plan as free: refused with limit 1, existing groups still read', async () => {
    const { user, codes } = await makeUser(
      'lapsed',
      { plan: 'host', planRenewsAt: new Date(Date.now() - DAY_MS) },
      3
    );
    caller = { id: user.id, role: 'host' };
    const res = await post(randomUUID());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'GROUP_LIMIT', limit: 1 });
    for (const code of codes) await request(server).get(`/groups/${code}`).expect(200);
  });

  it('still refuses another host\'s existing code with 404, not GROUP_LIMIT', async () => {
    const owner = await makeUser('owner', { plan: 'club' }, 1);
    const free = await makeUser('freeother', { plan: 'free' }, 1);
    caller = { id: free.user.id, role: 'host' };
    await post(owner.codes[0]).expect(404);
  });
});
