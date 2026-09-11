import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * Runs on every boot, not only the first — that is what makes the nullable
 * Group.ownerId column safe rather than sloppy (see the schema comment on
 * it): any group left ownerless, by a fresh deploy or by a future bug, is
 * picked up here rather than staying stuck.
 *
 * No public route can ever create an admin. This is the only path to one.
 */
@Injectable()
export class AuthBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AuthBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService
  ) {}

  async onModuleInit(): Promise<void> {
    const admin = await this.ensureAdmin();
    await this.backfillGroupOwners(admin.id);
  }

  private async ensureAdmin(): Promise<{ id: string }> {
    if ((await this.usersService.countAdmins()) > 0) {
      // An admin already exists, so ADMIN_EMAIL / ADMIN_PASSWORD are never
      // read on this boot — they are only a seed for the very first one, and
      // a deploy that has since dropped them from the environment must not
      // start failing here. Return any admin; only their id is used, to
      // backfill ownerless groups below.
      const existing = await this.prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
      return existing;
    }

    const email = process.env.ADMIN_EMAIL?.trim();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      throw new Error(
        'No admin account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set. ' +
          'The API will not start without a way to create the first admin — see server/.env.example.'
      );
    }

    const admin = await this.usersService.create(email, password, 'admin');
    this.logger.log(`Created the first admin account (${admin.email}).`);
    return admin;
  }

  private async backfillGroupOwners(adminId: string): Promise<void> {
    const { count } = await this.prisma.group.updateMany({
      where: { ownerId: null },
      data: { ownerId: adminId },
    });
    if (count > 0) {
      this.logger.log(`Assigned ${count} ownerless group(s) to the admin account.`);
    }
  }
}
