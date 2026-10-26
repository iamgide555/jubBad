import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansModule } from './plans.module.js';

describe('GET /plans/me', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: string;
  const groupCodes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, PlansModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    userId = (
      await prisma.user.create({
        data: { email: `pc-${randomUUID()}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
      })
    ).id;
    for (let i = 0; i < 2; i++) {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'PC', ownerId: userId } });
      groupCodes.push(code);
    }
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: userId, role: 'host' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it("returns the signed-in user's own plan, group count and cap", async () => {
    const res = await request(app.getHttpServer()).get('/plans/me').expect(200);
    expect(res.body).toMatchObject({ plan: 'free', groupCount: 2, groupLimit: 1, lapsedAt: null });
  });
});
