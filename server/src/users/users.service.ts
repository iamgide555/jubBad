import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export type Role = 'admin' | 'host';

/**
 * Email is the login identifier, and is matched case-insensitively — stored
 * lowercased so a lookup never depends on how the caller happened to type it.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  }

  countAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'admin' } });
  }

  async create(email: string, password: string, role: Role = 'host'): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: normalizeEmail(email),
        passwordHash: await hashPassword(password),
        role,
      },
    });
  }

  /**
   * Null on any failure to authenticate — wrong email, wrong password, or a
   * disabled account all look the same to the caller, which is what keeps a
   * failed login from confirming whether an address has an account at all.
   *
   * Always runs a scrypt comparison, even for an email with no account —
   * against DUMMY_HASH rather than short-circuiting — so an unknown address
   * does not answer measurably faster than a known one with a wrong password.
   */
  async verifyCredentials(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    const matches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || user.disabled || !matches) return null;
    return user;
  }
}

/**
 * A syntactically valid but unreachable scrypt hash — no password produces
 * it — used only to give verifyCredentials something to compare against when
 * no account matches the email, so the cost is paid either way.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
