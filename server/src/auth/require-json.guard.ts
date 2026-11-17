import { CanActivate, ExecutionContext, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Public auth POSTs take JSON only. Nest also parses form-encoded bodies, and a browser lets any other site submit
 * a form to this one: SameSite=Lax stops the session cookie being sent with it, but not being set by the answer, so a
 * cross-site form could sign a visitor in to an account its author made, or make accounts from visitors' addresses.
 * A page cannot send application/json cross-site without a preflight this server never allows.
 */
@Injectable()
export class RequireJsonGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (!req.is('application/json')) throw new UnsupportedMediaTypeException();
    return true;
  }
}
