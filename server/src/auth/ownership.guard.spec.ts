import { Reflector } from '@nestjs/core';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { OwnershipGuard } from './ownership.guard.js';
import { IS_PUBLIC } from './public.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const OWNER: User = {
  id: 'owner-1',
  email: 'owner@example.test',
  passwordHash: 'irrelevant',
  role: 'host',
  disabled: false,
  tokenVersion: 0,
  createdAt: new Date(),
};

const OTHER_HOST: User = { ...OWNER, id: 'other-host', email: 'other@example.test' };
const ADMIN: User = { ...OWNER, id: 'admin-1', role: 'admin' };

function reflectorSaying(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC ? isPublic : undefined),
  } as unknown as Reflector;
}

function contextFor(
  user: User,
  path: string,
  params: Record<string, string> = {}
): ExecutionContext {
  const request = { user, path, params };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

interface FakeGroup {
  code: string;
  ownerId: string | null;
}
interface FakeSession {
  code: string;
  groupId: string;
}

function fakePrisma(groups: FakeGroup[], sessions: FakeSession[] = []): PrismaService {
  return {
    group: {
      findUnique: async ({ where: { code } }: { where: { code: string } }) => {
        const group = groups.find((g) => g.code === code);
        return group ? { ownerId: group.ownerId } : null;
      },
    },
    session: {
      findUnique: async ({ where: { code } }: { where: { code: string } }) => {
        const session = sessions.find((s) => s.code === code);
        return session ? { groupId: session.groupId } : null;
      },
    },
  } as unknown as PrismaService;
}

function guard(
  isPublic: boolean,
  groups: FakeGroup[],
  sessions: FakeSession[] = []
): OwnershipGuard {
  return new OwnershipGuard(reflectorSaying(isPublic), fakePrisma(groups, sessions));
}

describe('OwnershipGuard', () => {
  it('lets a @Public() route through without even looking at the user', async () => {
    const g = guard(true, []);
    await expect(
      g.canActivate(contextFor(OWNER, '/groups/some-code', { code: 'some-code' }))
    ).resolves.toBe(true);
  });

  it('lets an admin through regardless of who owns the group', async () => {
    const g = guard(false, [{ code: 'g1', ownerId: OWNER.id }]);
    await expect(
      g.canActivate(contextFor(ADMIN, '/groups/g1/export', { code: 'g1' }))
    ).resolves.toBe(true);
  });

  it('skips /auth and /admin entirely', async () => {
    const g = guard(false, []);
    await expect(g.canActivate(contextFor(OWNER, '/auth/me', {}))).resolves.toBe(true);
    await expect(g.canActivate(contextFor(OWNER, '/admin/users', {}))).resolves.toBe(true);
  });

  it('lets GET /groups and POST /sessions through — neither has a :code to check here', async () => {
    const g = guard(false, []);
    await expect(g.canActivate(contextFor(OWNER, '/groups', {}))).resolves.toBe(true);
    await expect(g.canActivate(contextFor(OWNER, '/sessions', {}))).resolves.toBe(true);
  });

  describe('/groups/:code', () => {
    it('admits the owner', async () => {
      const g = guard(false, [{ code: 'g1', ownerId: OWNER.id }]);
      await expect(
        g.canActivate(contextFor(OWNER, '/groups/g1/sessions', { code: 'g1' }))
      ).resolves.toBe(true);
    });

    it('refuses a host who does not own it, with 404 not 403', async () => {
      const g = guard(false, [{ code: 'g1', ownerId: OWNER.id }]);
      await expect(
        g.canActivate(contextFor(OTHER_HOST, '/groups/g1/export', { code: 'g1' }))
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a code with no group through — this is how a new group is claimed', async () => {
      const g = guard(false, []);
      await expect(
        g.canActivate(contextFor(OTHER_HOST, '/groups/brand-new/parse', { code: 'brand-new' }))
      ).resolves.toBe(true);
    });
  });

  describe('/sessions/:code', () => {
    it('admits the owner of the session\'s group', async () => {
      const g = guard(
        false,
        [{ code: 'g1', ownerId: OWNER.id }],
        [{ code: 's1', groupId: 'g1' }]
      );
      await expect(
        g.canActivate(contextFor(OWNER, '/sessions/s1/end', { code: 's1' }))
      ).resolves.toBe(true);
    });

    it('refuses a host who does not own the session\'s group', async () => {
      const g = guard(
        false,
        [{ code: 'g1', ownerId: OWNER.id }],
        [{ code: 's1', groupId: 'g1' }]
      );
      await expect(
        g.canActivate(contextFor(OTHER_HOST, '/sessions/s1/end', { code: 's1' }))
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a session code that does not exist — unlike a group code, it is never claimable', async () => {
      const g = guard(false, []);
      await expect(
        g.canActivate(contextFor(OTHER_HOST, '/sessions/ghost/end', { code: 'ghost' }))
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('refuses a route it does not recognise the shape of, rather than waving it through', async () => {
    const g = guard(false, []);
    await expect(g.canActivate(contextFor(OWNER, '/something-unexpected', {}))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});
