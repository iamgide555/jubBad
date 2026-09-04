import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

describe('GroupsController', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 for a group that does not exist', async () => {
    await request(app.getHttpServer()).get(`/groups/${randomUUID()}`).expect(404);
  });

  it('creates, reads, renames a group, and lists its players', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Original Name' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Alice', aliases: '[]' },
    });

    try {
      const getRes = await request(app.getHttpServer()).get(`/groups/${code}`).expect(200);
      expect(getRes.body).toEqual({ code, name: 'Original Name', lastSessionCode: null });

      const putRes = await request(app.getHttpServer())
        .put(`/groups/${code}`)
        .send({ name: 'Renamed' })
        .expect(200);
      expect(putRes.body).toEqual({ code, name: 'Renamed' });

      const playersRes = await request(app.getHttpServer())
        .get(`/groups/${code}/players`)
        .expect(200);
      expect(playersRes.body).toEqual([{ id: player.id, name: 'Alice', aliases: [] }]);
    } finally {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('rejects an empty name on rename', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'X' } });
    try {
      await request(app.getHttpServer()).put(`/groups/${code}`).send({ name: '' }).expect(400);
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });
});
