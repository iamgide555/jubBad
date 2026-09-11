import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from './users.module.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  let prisma: PrismaService;
  let users: UsersService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, UsersModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
  });

  const email = () => `test-${randomUUID()}@example.test`;

  async function cleanup(id: string): Promise<void> {
    await prisma.user.deleteMany({ where: { id } });
  }

  it('creates a user with the password hashed, never stored plain', async () => {
    const address = email();
    const user = await users.create(address, 'a real password');
    try {
      expect(user.passwordHash).not.toBe('a real password');
      expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(user.role).toBe('host');
      expect(user.disabled).toBe(false);
      expect(user.tokenVersion).toBe(0);
    } finally {
      await cleanup(user.id);
    }
  });

  it('stores and looks up email case-insensitively', async () => {
    const address = email();
    const user = await users.create(address.toUpperCase(), 'password123');
    try {
      const found = await users.findByEmail(address.toLowerCase());
      expect(found?.id).toBe(user.id);
    } finally {
      await cleanup(user.id);
    }
  });

  it('verifies correct credentials and returns the user', async () => {
    const address = email();
    const user = await users.create(address, 'correct password');
    try {
      const result = await users.verifyCredentials(address, 'correct password');
      expect(result?.id).toBe(user.id);
    } finally {
      await cleanup(user.id);
    }
  });

  it('refuses a wrong password', async () => {
    const address = email();
    const user = await users.create(address, 'correct password');
    try {
      expect(await users.verifyCredentials(address, 'wrong password')).toBeNull();
    } finally {
      await cleanup(user.id);
    }
  });

  it('refuses an email with no account, without throwing', async () => {
    expect(await users.verifyCredentials(email(), 'anything')).toBeNull();
  });

  it('refuses a disabled user even with the correct password', async () => {
    const address = email();
    const user = await users.create(address, 'correct password');
    try {
      await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });
      expect(await users.verifyCredentials(address, 'correct password')).toBeNull();
    } finally {
      await cleanup(user.id);
    }
  });

  it('counts only admins', async () => {
    const before = await users.countAdmins();
    const host = await users.create(email(), 'password123', 'host');
    const admin = await users.create(email(), 'password123', 'admin');
    try {
      expect(await users.countAdmins()).toBe(before + 1);
    } finally {
      await cleanup(host.id);
      await cleanup(admin.id);
    }
  });
});
