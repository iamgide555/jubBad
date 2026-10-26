import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AdminModule } from '../admin/admin.module.js';
import { AdminService } from '../admin/admin.service.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { LineClient } from './line-client.js';

describe('admin deleting a user whose group is linked to LINE', () => {
  const fakeClient = { reply: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn() };
  let prisma: PrismaService;
  let users: UsersService;
  let admin: AdminService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AdminModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
    admin = moduleRef.get(AdminService);
  });

  it('asks the bot to leave the LINE group of a deleted group, and not of a reassigned one', async () => {
    fakeClient.leave.mockReset().mockResolvedValue(undefined);
    const owner = await users.create(`line-admin-del-${randomUUID()}@example.test`, 'password123');
    const heir = await users.create(`line-admin-heir-${randomUUID()}@example.test`, 'password123');
    const gone = randomUUID();
    const kept = randomUUID();
    const goneLine = `C${randomUUID()}`;
    const keptLine = `C${randomUUID()}`;
    await prisma.group.create({ data: { code: gone, name: 'gone', ownerId: owner.id, lineGroupId: goneLine } });
    await prisma.group.create({ data: { code: kept, name: 'kept', ownerId: owner.id, lineGroupId: keptLine } });

    await admin.deleteUser(owner.id, {
      [gone]: { action: 'delete' },
      [kept]: { action: 'reassign', toUserId: heir.id },
    });

    expect(fakeClient.leave).toHaveBeenCalledTimes(1);
    expect(fakeClient.leave).toHaveBeenCalledWith(goneLine);
    await prisma.group.deleteMany({ where: { code: kept } });
    await prisma.user.deleteMany({ where: { id: heir.id } });
  });
});
