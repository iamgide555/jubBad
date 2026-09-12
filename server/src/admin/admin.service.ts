import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateUserDto } from './dto/create-user.dto.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';
import type { GroupDisposition } from './dto/delete-user.dto.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly groupsService: GroupsService,
    private readonly passwordResetService: PasswordResetService
  ) {}

  /**
   * Every user, with the groups they own — the users table flags an owner
   * before the admin ever clicks delete, which is the point: the consequence
   * of deleting them is on screen, not discovered behind a confirmation.
   */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      include: { groups: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt,
      ownedGroups: u.groups.map((g) => ({ code: g.code, name: g.name })),
    }));
  }

  async createUser(dto: CreateUserDto) {
    try {
      return await this.usersService.create(dto.email, dto.password, dto.role ?? 'host');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('อีเมลนี้ถูกใช้แล้ว');
      }
      throw error;
    }
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException();

    try {
      return await this.prisma.user.update({
        where: { id },
        data: { email: dto.email?.trim().toLowerCase(), role: dto.role },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('อีเมลนี้ถูกใช้แล้ว');
      }
      throw error;
    }
  }

  /**
   * Takes the desired state, not a flip — two taps in flight must not cancel
   * out, the same reasoning as the roster active toggle.
   *
   * Disabling bumps tokenVersion, so every cookie already issued to this user
   * stops working on their very next request rather than surviving up to 30
   * more days — see session.ts. Re-enabling does not: there is nothing to
   * revoke, and a fresh tokenVersion would only sign out a device that was
   * never actually a problem.
   */
  async setDisabled(id: string, disabled: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException();

    return this.prisma.user.update({
      where: { id },
      data: disabled
        ? { disabled: true, tokenVersion: { increment: 1 } }
        : { disabled: false },
    });
  }

  /** Mints a one-time reset URL token. Returned once — nothing stores it raw. */
  async resetUserPassword(id: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException();
    return this.passwordResetService.issue(id);
  }

  /**
   * Deletes a user, but never decides a group's fate as a side effect —
   * `disposition` must name every group this user owns, explicitly, as
   * either `reassign` (to `toUserId`) or `delete`. Everything — every
   * reassignment, every group's full cascade delete, and the user row
   * itself — runs in one `$transaction`; a half-deleted user with two of
   * four groups gone is the worst outcome available here.
   */
  async deleteUser(
    id: string,
    disposition: Record<string, GroupDisposition>
  ): Promise<{ deleted: true }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { groups: { select: { code: true } } },
    });
    if (!user) throw new NotFoundException();

    const ownedCodes = user.groups.map((g) => g.code);
    const namedCodes = Object.keys(disposition);

    // Every owned group must appear, and nothing else — a missing code would
    // dispose of a group by omission, and an extra one is a stale admin tab
    // acting on a list that has since changed.
    if (
      ownedCodes.length !== namedCodes.length ||
      !ownedCodes.every((code) => code in disposition)
    ) {
      throw new BadRequestException(
        'ต้องระบุการจัดการให้ครบทุกก๊วนที่ผู้ใช้นี้เป็นเจ้าของ เท่านั้น'
      );
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const code of ownedCodes) {
      const entry = disposition[code];
      if (entry.action === 'delete') {
        const deleteOps = await this.groupsService.buildDeleteGroupOps(code);
        if (!deleteOps) throw new NotFoundException(); // race: group vanished mid-request
        ops.push(...deleteOps);
      } else if (entry.action === 'reassign') {
        if (!entry.toUserId) {
          throw new BadRequestException(`ต้องระบุผู้รับสิทธิ์สำหรับก๊วน ${code}`);
        }
        const target = await this.prisma.user.findUnique({ where: { id: entry.toUserId } });
        if (!target) throw new BadRequestException(`ไม่พบผู้ใช้ปลายทางสำหรับก๊วน ${code}`);
        ops.push(this.prisma.group.update({ where: { code }, data: { ownerId: entry.toUserId } }));
      } else {
        throw new BadRequestException(`การจัดการไม่ถูกต้องสำหรับก๊วน ${code}`);
      }
    }

    ops.push(this.prisma.user.delete({ where: { id } }));
    await this.prisma.$transaction(ops);
    return { deleted: true };
  }

  /** Every group with its owner — the admin's view across every host. */
  async listGroups() {
    const groups = await this.prisma.group.findMany({
      include: { owner: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return groups.map((g) => ({
      code: g.code,
      name: g.name,
      owner: g.owner ? { id: g.owner.id, email: g.owner.email } : null,
    }));
  }

  async reassignGroupOwner(code: string, toUserId: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const target = await this.prisma.user.findUnique({ where: { id: toUserId } });
    if (!target) throw new BadRequestException('ไม่พบผู้ใช้ปลายทาง');

    return this.prisma.group.update({ where: { code }, data: { ownerId: toUserId } });
  }

  /** Unhandled requests, newest first — the admin page shows a count badge. */
  async listResetRequests() {
    return this.prisma.passwordResetRequest.findMany({
      where: { handledAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Marks one request handled. Deliberately does not mint a reset itself —
   * that stays a separate action against a specific user (resetUserPassword)
   * so a request whose email matches no account can still be dismissed
   * without forcing a reset to happen.
   */
  async handleResetRequest(id: string, adminId: string): Promise<void> {
    const { count } = await this.prisma.passwordResetRequest.updateMany({
      where: { id, handledAt: null },
      data: { handledAt: new Date(), handledBy: adminId },
    });
    if (count === 0) throw new NotFoundException();
  }
}
