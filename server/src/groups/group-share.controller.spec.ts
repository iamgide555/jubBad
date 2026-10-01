import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

describe('group share routes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const admin = await prisma.user.create({
      data: { email: `share-ctrl-${randomUUID()}@example.test`, passwordHash: 'test', role: 'admin' },
    });
    adminId = admin.id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: adminId, role: 'admin' };
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('walks the lifecycle: none -> share -> same on re-share -> stop', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Lifecycle' } });
    try {
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });

      const created = await request(server).post(`/groups/${code}/share`).expect(201);
      expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const again = await request(server).post(`/groups/${code}/share`).expect(201);
      expect(again.body).toEqual(created.body);
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual(created.body);

      expect((await request(server).delete(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('404s all three verbs for a group that does not exist', async () => {
    const code = randomUUID();
    await request(server).get(`/groups/${code}/share`).expect(404);
    await request(server).post(`/groups/${code}/share`).expect(404);
    await request(server).delete(`/groups/${code}/share`).expect(404);
  });
});
