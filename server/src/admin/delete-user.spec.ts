import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminModule } from './admin.module.js';
import { AdminService } from './admin.service.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * The disposition contract on DELETE /admin/users/:id — this is where the
 * real risk is, not the happy path (see admin.spec.ts for that): an
 * incomplete body must delete nothing, a stale or unknown group code must
 * delete nothing, and a failure partway through a mixed reassign-and-delete
 * batch must roll the whole thing back rather than leave the user half gone.
 */
describe('AdminService.deleteUser', () => {
  let prisma: PrismaService;
  let users: UsersService;
  let admin: AdminService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AdminModule],
    })
      // Never initialized into a running app (no createNestApplication/init
      // here), so AuthBootstrapService may or may not run automatically —
      // overridden regardless, so this file does not depend on
      // ADMIN_EMAIL/ADMIN_PASSWORD being set in whatever environment it runs.
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
    admin = moduleRef.get(AdminService);
  });

  async function makeOwner(groupCount: number) {
    const owner = await users.create(`delete-target-${randomUUID()}@example.test`, 'password123');
    const codes: string[] = [];
    for (let i = 0; i < groupCount; i++) {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: `Group ${i}`, ownerId: owner.id } });
      codes.push(code);
    }
    return { owner, codes };
  }

  async function cleanup(userId: string, codes: string[]) {
    await prisma.group.deleteMany({ where: { code: { in: codes } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  it('deletes a user who owns nothing with an empty disposition', async () => {
    const { owner } = await makeOwner(0);
    await admin.deleteUser(owner.id, {});
    expect(await users.findById(owner.id)).toBeNull();
  });

  it('refuses a disposition missing an owned group, deleting nothing', async () => {
    const { owner, codes } = await makeOwner(1);
    try {
      await expect(admin.deleteUser(owner.id, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(await users.findById(owner.id)).not.toBeNull();
      expect(await prisma.group.findUnique({ where: { code: codes[0] } })).not.toBeNull();
    } finally {
      await cleanup(owner.id, codes);
    }
  });

  it('refuses a disposition naming a group the user does not own, deleting nothing', async () => {
    const { owner, codes } = await makeOwner(1);
    const staleCode = randomUUID();
    try {
      await expect(
        admin.deleteUser(owner.id, {
          [codes[0]]: { action: 'delete' },
          [staleCode]: { action: 'delete' },
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await users.findById(owner.id)).not.toBeNull();
      expect(await prisma.group.findUnique({ where: { code: codes[0] } })).not.toBeNull();
    } finally {
      await cleanup(owner.id, codes);
    }
  });

  it('refuses a reassign with no destination user, deleting nothing', async () => {
    const { owner, codes } = await makeOwner(1);
    try {
      await expect(
        admin.deleteUser(owner.id, { [codes[0]]: { action: 'reassign' } })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await users.findById(owner.id)).not.toBeNull();
    } finally {
      await cleanup(owner.id, codes);
    }
  });

  it('refuses a reassign to a user that does not exist, deleting nothing', async () => {
    const { owner, codes } = await makeOwner(1);
    try {
      await expect(
        admin.deleteUser(owner.id, {
          [codes[0]]: { action: 'reassign', toUserId: 'not-a-real-user' },
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await users.findById(owner.id)).not.toBeNull();
      const group = await prisma.group.findUniqueOrThrow({ where: { code: codes[0] } });
      expect(group.ownerId).toBe(owner.id);
    } finally {
      await cleanup(owner.id, codes);
    }
  });

  it('leaves an owned group unassigned rather than forcing a destination user', async () => {
    const { owner, codes } = await makeOwner(1);
    try {
      await admin.deleteUser(owner.id, { [codes[0]]: { action: 'unassign' } });
      expect(await users.findById(owner.id)).toBeNull();
      const group = await prisma.group.findUniqueOrThrow({ where: { code: codes[0] } });
      expect(group.ownerId).toBeNull();
    } finally {
      await prisma.group.deleteMany({ where: { code: codes[0] } });
    }
  });

  it('applies a mixed reassign-and-delete batch atomically', async () => {
    const { owner, codes } = await makeOwner(2);
    const [toDelete, toReassign] = codes;
    const newOwner = await users.create(`new-owner-${randomUUID()}@example.test`, 'password123');

    try {
      await admin.deleteUser(owner.id, {
        [toDelete]: { action: 'delete' },
        [toReassign]: { action: 'reassign', toUserId: newOwner.id },
      });

      expect(await users.findById(owner.id)).toBeNull();
      expect(await prisma.group.findUnique({ where: { code: toDelete } })).toBeNull();
      const reassigned = await prisma.group.findUniqueOrThrow({ where: { code: toReassign } });
      expect(reassigned.ownerId).toBe(newOwner.id);
    } finally {
      await prisma.group.deleteMany({ where: { code: toReassign } });
      await prisma.user.deleteMany({ where: { id: newOwner.id } });
    }
  });

  it('deletes several owned groups together with their pair rules', async () => {
    const { owner, codes } = await makeOwner(2);
    for (const code of codes) {
      const a = await prisma.player.create({ data: { groupId: code, name: 'A', aliases: '[]' } });
      const b = await prisma.player.create({ data: { groupId: code, name: 'B', aliases: '[]' } });
      const [lo, hi] = [a.id, b.id].sort();
      await prisma.playerRule.create({ data: { groupId: code, playerAId: lo, playerBId: hi, kind: 'must-pair' } });
    }

    await admin.deleteUser(owner.id, Object.fromEntries(codes.map((c) => [c, { action: 'delete' as const }])));

    expect(await prisma.playerRule.count({ where: { groupId: { in: codes } } })).toBe(0);
    expect(await prisma.player.count({ where: { groupId: { in: codes } } })).toBe(0);
    expect(await prisma.group.count({ where: { code: { in: codes } } })).toBe(0);
  });

  it('rolls back a mixed batch entirely when one entry is invalid', async () => {
    const { owner, codes } = await makeOwner(2);
    const [toDelete, toReassign] = codes;

    try {
      await expect(
        admin.deleteUser(owner.id, {
          [toDelete]: { action: 'delete' },
          [toReassign]: { action: 'reassign', toUserId: 'not-a-real-user' },
        })
      ).rejects.toBeInstanceOf(BadRequestException);

      // Nothing happened — not even the valid half of the batch.
      expect(await users.findById(owner.id)).not.toBeNull();
      expect(await prisma.group.findUnique({ where: { code: toDelete } })).not.toBeNull();
      const untouched = await prisma.group.findUniqueOrThrow({ where: { code: toReassign } });
      expect(untouched.ownerId).toBe(owner.id);
    } finally {
      await cleanup(owner.id, codes);
    }
  });

  it('refuses a user that does not exist', async () => {
    await expect(admin.deleteUser('not-a-real-user', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('numbered shuttle: admin deletion removes game links, pairings and identities in FK order', async () => {
    const { owner, codes } = await makeOwner(1);
    const sessionCode = randomUUID();
    try {
      await prisma.session.create({ data: { code: sessionCode, groupId: codes[0], rawImportText: '', shuttleToolsEnabled: true } });
      const shuttle = await prisma.sessionShuttle.create({ data: { sessionId: sessionCode, number: 1 } });
      const game = await prisma.pairing.create({
        data: { sessionId: sessionCode, courtNumber: 1, matchNumber: 1, teamA: '["a","b"]', teamB: '["c","d"]', shuttleLogKnown: true, lastShuttleId: shuttle.id },
      });
      await prisma.pairingShuttleUse.create({ data: { pairingId: game.id, shuttleId: shuttle.id } });

      await admin.deleteUser(owner.id, { [codes[0]]: { action: 'delete' } });

      expect(await prisma.pairingShuttleUse.count({ where: { pairingId: game.id } })).toBe(0);
      expect(await prisma.sessionShuttle.count({ where: { sessionId: sessionCode } })).toBe(0);
      expect(await prisma.pairing.count({ where: { sessionId: sessionCode } })).toBe(0);
      expect(await prisma.group.count({ where: { code: codes[0] } })).toBe(0);
      expect(await users.findById(owner.id)).toBeNull();
    } finally {
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: sessionCode } } });
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionShuttle.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await cleanup(owner.id, codes);
    }
  });
});
