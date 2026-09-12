import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';
import { PasswordResetService } from './password-reset.service.js';

describe('PasswordResetService', () => {
  let prisma: PrismaService;
  let users: UsersService;
  let resets: PasswordResetService;
  let userId: string;
  const originalPassword = 'the original password';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, UsersModule],
      providers: [PasswordResetService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
    resets = moduleRef.get(PasswordResetService);
  });

  beforeEach(async () => {
    const user = await users.create(`reset-${randomUUID()}@example.test`, originalPassword);
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.passwordReset.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('issues a token that consume() accepts, setting the new password', async () => {
    const token = await resets.issue(userId);
    expect(await resets.consume(token, 'a brand new password')).toBe(true);

    const user = await users.findById(userId);
    expect(await users.verifyCredentials(user!.email, 'a brand new password')).not.toBeNull();
    expect(await users.verifyCredentials(user!.email, originalPassword)).toBeNull();
  });

  it('bumps tokenVersion on consume, signing every existing cookie out', async () => {
    const before = await users.findById(userId);
    const token = await resets.issue(userId);
    await resets.consume(token, 'a brand new password');

    const after = await users.findById(userId);
    expect(after!.tokenVersion).toBe(before!.tokenVersion + 1);
  });

  it('is single-use — a second consume of the same token fails', async () => {
    const token = await resets.issue(userId);
    expect(await resets.consume(token, 'first new password')).toBe(true);
    expect(await resets.consume(token, 'second new password')).toBe(false);

    // ...and the first password change is the one that actually stuck.
    const user = await users.findById(userId);
    expect(await users.verifyCredentials(user!.email, 'first new password')).not.toBeNull();
  });

  it('rejects a token that was never issued', async () => {
    expect(await resets.consume('not-a-real-token', 'anything')).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await resets.issue(userId);
    // Back-date it directly — issue() always mints a live one.
    await prisma.passwordReset.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resets.consume(token, 'anything')).toBe(false);
  });

  it('records a forgot-password request with no branch on whether the email exists', async () => {
    const email = `unknown-${randomUUID()}@example.test`;
    await resets.recordRequest(email);
    const request = await prisma.passwordResetRequest.findFirst({ where: { email } });
    expect(request).not.toBeNull();
    expect(request!.handledAt).toBeNull();

    await prisma.passwordResetRequest.deleteMany({ where: { email } });
  });
});
