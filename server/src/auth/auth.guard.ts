import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@prisma/client';
import type { Request } from 'express';
import { IS_PUBLIC } from './public.decorator.js';
import { parseSession, SESSION_COOKIE } from './session.js';
import { UsersService } from '../users/users.service.js';

/** A route handler can read `req.user` once this guard has passed. */
export interface AuthenticatedRequest extends Request {
  user: User;
}

/**
 * Default-deny. Every route requires a valid session cookie unless it is
 * marked @Public(). Registered as an APP_GUARD in auth.module.ts.
 *
 * Formerly AdminGuard, comparing one shared token. Now resolves the signed
 * cookie to a User and checks it is still live — not disabled, and not
 * superseded by a tokenVersion bump (see session.ts). OwnershipGuard is the
 * second global guard and runs after this one; it decides *which* groups a
 * resolved user may reach.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = await resolveSessionUser(request, this.usersService);
    if (!user) {
      /**
       * Throwing rather than returning false, so this is a 401 and not Nest's
       * default 403 for a refused guard. The distinction is load-bearing on
       * the client: 401 means "you are not signed in, go to the login page",
       * while 403 would mean "you are signed in and still may not do this" —
       * a state OwnershipGuard now has, but the client must not mistake one
       * for the other. See OwnershipGuard's own comment for why *it* answers
       * 404 rather than 403.
       */
      throw new UnauthorizedException('ต้องเข้าสู่ระบบก่อน');
    }

    (request as AuthenticatedRequest).user = user;
    return true;
  }
}

/**
 * Reads the signed session cookie and resolves it to a live User, or null on
 * any failure — no cookie, a bad signature, a malformed payload, an unknown
 * user, a disabled one, or a tokenVersion that no longer matches (the cookie
 * was issued before a disable, password change, or reset).
 *
 * Exported separately from the guard because `GET /auth/me` is @Public() —
 * it has to answer an anonymous caller rather than 401 them — but still needs
 * this exact resolution to report whether the caller happens to be signed in.
 */
export async function resolveSessionUser(
  request: Request,
  usersService: UsersService
): Promise<User | null> {
  const signed = (request as Request & { signedCookies?: Record<string, string | false> })
    .signedCookies?.[SESSION_COOKIE];
  const parsed = parseSession(signed);
  if (!parsed) return null;

  const user = await usersService.findById(parsed.userId);
  if (!user || user.disabled || user.tokenVersion !== parsed.tokenVersion) return null;

  return user;
}
