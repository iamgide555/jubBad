import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The second global guard, running after AuthGuard. AuthGuard answers "is
 * this a real, live user?"; this one answers "does that user own the group
 * this route touches?" — the identity question and the access question are
 * deliberately two guards, not one, so a bug in either is legible on its own.
 *
 * Default-deny like AuthGuard: a route this guard does not recognise the
 * shape of is refused, not waved through. Refuses with 404 rather than 403 —
 * a 403 would confirm the group code exists at all, which is exactly what an
 * 8-hex-char code must not confirm to a caller who does not own it.
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // AuthGuard ran first and would have thrown already if this were unset.
    const user = request.user;
    if (user.role === 'admin') return true;

    const path = request.path;

    // /auth's own routes are all @Public() already, so nothing not already
    // handled above ever reaches here for them.
    if (path.startsWith('/auth')) return true;

    // Reaching this line already means role !== 'admin' — the check at the
    // top of this method would have returned already otherwise. /admin
    // addresses no group, so this guard is not the one deciding whether an
    // admin route is allowed; it is simply the wrong caller, refused the
    // same way an unrecognised route shape would be.
    if (path.startsWith('/admin')) throw new NotFoundException();

    // Addresses no group at all, so ownership has nothing to check: GET /
    // (AppController's scaffold route). GET /groups is filtered by owner at
    // the service layer (GroupsService.listGroups) instead of here, and POST
    // /sessions names its group in the body, not the URL — checked in
    // SessionsService.createSession, which is the only place that can.
    if (path === '/' || path === '/groups' || path === '/sessions') return true;

    // Express types params as `string | string[]` (a repeated segment could
    // in principle produce an array); every route here declares :code once,
    // so anything but a single string is not a shape this guard recognises.
    const code = request.params['code'];
    if (typeof code !== 'string') throw new NotFoundException();

    if (path.startsWith('/groups/')) {
      const group = await this.prisma.group.findUnique({
        where: { code },
        select: { ownerId: true },
      });
      // No group at this code yet is exactly how a new one gets claimed —
      // GroupsService.parse is the only route that creates a group, and it
      // does so as this caller. Every other route on a code with no group
      // (rename, list sessions, export, delete) simply finds nothing to act
      // on, the same as if the group had already been deleted — nothing here
      // leaks, because there is no owner to disagree with yet.
      if (!group || group.ownerId === user.id) return true;
      throw new NotFoundException();
    }

    if (path.startsWith('/sessions/')) {
      const session = await this.prisma.session.findUnique({
        where: { code },
        select: { groupId: true },
      });
      // Unlike a group code, a session code is never client-chosen — it only
      // ever exists because SessionsService.createSession made it (itself
      // already ownership-checked, see above). A missing one is not
      // claimable, it is simply gone.
      if (!session) throw new NotFoundException();
      const group = await this.prisma.group.findUnique({
        where: { code: session.groupId },
        select: { ownerId: true },
      });
      if (group?.ownerId === user.id) return true;
      throw new NotFoundException();
    }

    // A route shaped like nothing above — refuse rather than wave through,
    // the same default-deny AuthGuard applies to identity.
    throw new NotFoundException();
  }
}
