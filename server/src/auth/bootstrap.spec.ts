import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { AuthBootstrapService } from './bootstrap.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';

describe('AuthBootstrapService', () => {
  let prisma: PrismaService;
  let users: UsersService;
  let bootstrap: AuthBootstrapService;
  const originalEmail = process.env.ADMIN_EMAIL;
  const originalPassword = process.env.ADMIN_PASSWORD;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, UsersModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
    bootstrap = new AuthBootstrapService(prisma, users);
  });

  afterEach(() => {
    if (originalEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalEmail;
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
  });

  /**
   * Every test starts by clearing every admin-role user, rather than
   * assuming the shared test database has none — other spec files that
   * import AuthModule trigger this same service through Nest's app
   * lifecycle, so an admin left over from file order is the realistic
   * starting state, not an edge case.
   */
  async function clearAdmins(): Promise<void> {
    await prisma.user.deleteMany({ where: { role: 'admin' } });
  }

  it('creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when none exists', async () => {
    await clearAdmins();
    const email = `admin-${randomUUID()}@example.test`;
    process.env.ADMIN_EMAIL = email;
    process.env.ADMIN_PASSWORD = 'a genuinely correct password';

    await bootstrap.onModuleInit();

    const admin = await users.findByEmail(email);
    expect(admin?.role).toBe('admin');
    expect(await users.countAdmins()).toBe(1);
  });

  it('does nothing on a second boot, even with no env vars set', async () => {
    await clearAdmins();
    const email = `admin-${randomUUID()}@example.test`;
    process.env.ADMIN_EMAIL = email;
    process.env.ADMIN_PASSWORD = 'a genuinely correct password';
    await bootstrap.onModuleInit();
    expect(await users.countAdmins()).toBe(1);

    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    await expect(bootstrap.onModuleInit()).resolves.not.toThrow();
    expect(await users.countAdmins()).toBe(1);
  });

  it('throws rather than boot with no admin and no way to create one', async () => {
    await clearAdmins();
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;

    await expect(bootstrap.onModuleInit()).rejects.toThrow(/ADMIN_EMAIL/);
    expect(await users.countAdmins()).toBe(0);
  });

  it('backfills every ownerless group to the admin, and leaves owned ones alone', async () => {
    await clearAdmins();
    const email = `admin-${randomUUID()}@example.test`;
    process.env.ADMIN_EMAIL = email;
    process.env.ADMIN_PASSWORD = 'a genuinely correct password';

    const otherOwner = await users.create(`host-${randomUUID()}@example.test`, 'password123');
    const ownerlessCode = `test-ownerless-${randomUUID()}`;
    const ownedCode = `test-owned-${randomUUID()}`;
    await prisma.group.create({ data: { code: ownerlessCode, name: 'Ownerless' } });
    await prisma.group.create({
      data: { code: ownedCode, name: 'Already owned', ownerId: otherOwner.id },
    });

    try {
      await bootstrap.onModuleInit();
      const admin = await users.findByEmail(email);

      const ownerless = await prisma.group.findUniqueOrThrow({ where: { code: ownerlessCode } });
      const owned = await prisma.group.findUniqueOrThrow({ where: { code: ownedCode } });

      expect(ownerless.ownerId).toBe(admin?.id);
      expect(owned.ownerId).toBe(otherOwner.id);
    } finally {
      await prisma.group.deleteMany({ where: { code: { in: [ownerlessCode, ownedCode] } } });
      await prisma.user.deleteMany({ where: { id: otherOwner.id } });
    }
  });
});
