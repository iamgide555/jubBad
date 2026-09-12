import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthGuard, AuthenticatedRequest } from './auth.guard.js';
import { IS_PUBLIC } from './public.decorator.js';
import { packSession, SESSION_COOKIE } from './session.js';
import type { UsersService } from '../users/users.service.js';

const LIVE_USER: User = {
  id: 'user-1',
  email: 'host@example.test',
  passwordHash: 'irrelevant',
  role: 'host',
  disabled: false,
  tokenVersion: 3,
  createdAt: new Date(),
};

function contextWith(signedCookies: Record<string, string | false>): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = { signedCookies };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, request };
}

/** A Reflector that reports every route as public, or none of them. */
function reflectorSaying(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC ? isPublic : undefined),
  } as unknown as Reflector;
}

function usersServiceReturning(user: User | null): UsersService {
  return { findById: async () => user } as unknown as UsersService;
}

function guard(isPublic: boolean, user: User | null): AuthGuard {
  return new AuthGuard(reflectorSaying(isPublic), usersServiceReturning(user));
}

describe('AuthGuard', () => {
  // 401, not 403: the caller has presented no valid identity, and the web
  // client tells "log in" and "you may not do that" apart by this status.
  it('rejects a request with no cookie at all', async () => {
    const { context } = contextWith({});
    await expect(guard(false, LIVE_USER).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it('rejects an invalid signature (cookie-parser reports `false`)', async () => {
    const { context } = contextWith({ [SESSION_COOKIE]: false });
    await expect(guard(false, LIVE_USER).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it('rejects a malformed payload', async () => {
    const { context } = contextWith({ [SESSION_COOKIE]: 'not-a-session-payload' });
    await expect(guard(false, LIVE_USER).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it('rejects a session for a user that no longer exists', async () => {
    const { context } = contextWith({ [SESSION_COOKIE]: packSession('gone', 0) });
    await expect(guard(false, null).canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a disabled user even with a well-formed, live session', async () => {
    const disabled: User = { ...LIVE_USER, disabled: true };
    const { context } = contextWith({
      [SESSION_COOKIE]: packSession(disabled.id, disabled.tokenVersion),
    });
    await expect(guard(false, disabled).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it('rejects a session whose tokenVersion has been superseded', async () => {
    // The cookie was issued at version 2; the user has since been bumped to 3
    // (disable, password change, or reset) — see session.ts.
    const { context } = contextWith({ [SESSION_COOKIE]: packSession(LIVE_USER.id, 2) });
    await expect(guard(false, LIVE_USER).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it('accepts a live session and attaches the user to the request', async () => {
    const { context, request } = contextWith({
      [SESSION_COOKIE]: packSession(LIVE_USER.id, LIVE_USER.tokenVersion),
    });
    await expect(guard(false, LIVE_USER).canActivate(context)).resolves.toBe(true);
    expect((request as unknown as AuthenticatedRequest).user).toEqual(LIVE_USER);
  });

  it('lets a @Public() route through with no cookie', async () => {
    const { context } = contextWith({});
    await expect(guard(true, null).canActivate(context)).resolves.toBe(true);
  });

  it('survives a request with no signedCookies property', async () => {
    const request: Record<string, unknown> = {};
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    await expect(guard(false, LIVE_USER).canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });
});
