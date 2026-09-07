import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { IS_PUBLIC } from './public.decorator.js';

export const ADMIN_COOKIE = 'jubbad_admin';

/** Injection token for the configured secret, so tests can supply their own. */
export const ADMIN_TOKEN = 'ADMIN_TOKEN';

/**
 * Default-deny. Every route requires the admin cookie unless it is marked
 * @Public(). Registered as an APP_GUARD in app.module.ts.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ADMIN_TOKEN) private readonly adminToken: string
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ cookies?: Record<string, string> }>();
    if (!matchesToken(request.cookies?.[ADMIN_COOKIE], this.adminToken)) {
      /**
       * Throwing rather than returning false, so this is a 401 and not Nest's
       * default 403 for a refused guard. The distinction is load-bearing on the
       * client: 401 means "you are not signed in, go to the login page", while
       * 403 would mean "you are signed in and still may not do this" — a state
       * this app has no concept of, and one the route guard must not treat as a
       * reason to show a login form.
       */
      throw new UnauthorizedException('ต้องเข้าสู่ระบบก่อน');
    }
    return true;
  }
}

/**
 * Constant-time comparison, so the response time cannot be used to discover the
 * token one character at a time.
 *
 * The length check is not an optimisation — timingSafeEqual throws outright on
 * buffers of different lengths, so reaching it with a wrong-length candidate
 * would turn a failed login into a 500. Length is not a secret worth protecting
 * here; the token's contents are.
 */
export function matchesToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate || !expected) return false;

  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
