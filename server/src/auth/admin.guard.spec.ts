import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminGuard, ADMIN_COOKIE } from './admin.guard.js';
import { IS_PUBLIC } from './public.decorator.js';

const TOKEN = 'correct-horse-battery-staple';

function contextWith(cookies: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ cookies }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** A Reflector that reports every route as public, or none of them. */
function reflectorSaying(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC ? isPublic : undefined),
  } as unknown as Reflector;
}

function guard(isPublic = false): AdminGuard {
  return new AdminGuard(reflectorSaying(isPublic), TOKEN);
}

describe('AdminGuard', () => {
  // 401, not 403: the caller has presented no valid identity, and the web
  // client tells "log in" and "you may not do that" apart by this status.
  it('rejects a request with no cookie at all', () => {
    expect(() => guard().canActivate(contextWith({}))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong token', () => {
    expect(() => guard().canActivate(contextWith({ [ADMIN_COOKIE]: 'wrong' }))).toThrow(
      UnauthorizedException
    );
  });

  it('rejects a token that is a prefix of the real one', () => {
    // timingSafeEqual throws on a length mismatch rather than returning false,
    // so the length has to be checked before it is reached.
    expect(() =>
      guard().canActivate(contextWith({ [ADMIN_COOKIE]: TOKEN.slice(0, -1) }))
    ).toThrow(UnauthorizedException);
  });

  it('rejects a token that is the real one plus a suffix', () => {
    expect(() => guard().canActivate(contextWith({ [ADMIN_COOKIE]: TOKEN + 'x' }))).toThrow(
      UnauthorizedException
    );
  });

  it('accepts the correct token', () => {
    expect(guard().canActivate(contextWith({ [ADMIN_COOKIE]: TOKEN }))).toBe(true);
  });

  it('lets a @Public() route through with no cookie', () => {
    expect(guard(true).canActivate(contextWith({}))).toBe(true);
  });

  it('survives a request with no cookies property', () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    expect(() => guard().canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
