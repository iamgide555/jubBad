import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminGuard, ADMIN_TOKEN } from './admin.guard.js';
import { AuthController } from './auth.controller.js';
import { LoginThrottle } from './login-throttle.js';

/**
 * Reads the secret at module construction rather than at import, so tests can
 * replace the provider without ever running this.
 *
 * Throwing is the point. An unset secret must not degrade to "let everyone in":
 * that failure is invisible in production — the app boots, every page works,
 * and nothing indicates the door is open. A container that refuses to start is
 * noticed immediately.
 */
export function requireAdminToken(): string {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'ADMIN_TOKEN is not set. The API will not start without it — see server/.env.example.'
    );
  }
  return token;
}

@Module({
  controllers: [AuthController],
  providers: [
    { provide: ADMIN_TOKEN, useFactory: requireAdminToken },
    LoginThrottle,
    /**
     * Global. Registering it here rather than per-controller is what makes the
     * default deny: a route added anywhere in the app is closed until someone
     * marks it @Public().
     */
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
  exports: [ADMIN_TOKEN],
})
export class AuthModule {}
