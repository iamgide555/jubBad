import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LineHostService } from '../line/line-host.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';
import { GroupsService } from './groups.service.js';

describe('a new group’s roster-by-DM switch follows its owner’s LINE link', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let groups: GroupsService;
  const userIds: string[] = [];
  const codes: string[] = [];

  async function owner(data: { plan: string; linked: boolean }) {
    const user = await prisma.user.create({
      data: {
        email: `gld-${randomUUID()}@example.test`,
        passwordHash: 'test',
        role: 'host',
        plan: data.plan,
        lineUserId: data.linked ? `U${randomUUID().replace(/-/g, '')}` : null,
      },
    });
    userIds.push(user.id);
    return { id: user.id, role: 'host' };
  }

  async function create(caller: { id: string; role: string }, code = `gld-${randomUUID()}`) {
    codes.push(code);
    await groups.create({ code, name: 'ก๊วนทดสอบ' }, caller);
    return code;
  }

  const switchOf = async (code: string) =>
    (await prisma.group.findUniqueOrThrow({ where: { code } })).lineDmEnabled;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    groups = app.get(GroupsService);
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { code: { in: codes } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('a linked host on the Host plan gets a new group with the roster switch on', async () => {
    expect(await switchOf(await create(await owner({ plan: 'host', linked: true })))).toBe(true);
  });

  it('a linked host on free gets it off', async () => {
    expect(await switchOf(await create(await owner({ plan: 'free', linked: true })))).toBe(false);
  });

  it('an unlinked host on club gets it off', async () => {
    expect(await switchOf(await create(await owner({ plan: 'club', linked: false })))).toBe(false);
  });

  it('retrying the create of an existing group does not flip the switch', async () => {
    const caller = await owner({ plan: 'host', linked: true });
    const code = await create(caller);
    await app.get(LineHostService).setEnabled(code, false);
    await groups.create({ code, name: 'ก๊วนทดสอบ' }, caller);
    expect(await switchOf(code)).toBe(false);
  });
});
