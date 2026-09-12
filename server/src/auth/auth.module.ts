import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { OwnershipGuard } from './ownership.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthBootstrapService } from './bootstrap.service.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordResetService } from './password-reset.service.js';
import { UsersModule } from '../users/users.module.js';

/** Injection token for the cookie-signing secret, so tests can supply their own. */
export const SESSION_SECRET = 'SESSION_SECRET';

/**
 * Reads the secret at module construction rather than at import, so tests can
 * replace the provider without ever running this.
 *
 * Throwing is the point. An unset secret must not degrade to "sign cookies
 * with nothing" or "start up unable to verify any cookie": that failure is
 * invisible in production — the app boots, every page works until someone's
 * session is silently rejected, and nothing indicates why. A container that
 * refuses to start is noticed immediately.
 */
export function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. The API will not start without it — see server/.env.example.'
    );
  }
  return secret;
}

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    { provide: SESSION_SECRET, useFactory: requireSessionSecret },
    LoginThrottle,
    AuthBootstrapService,
    PasswordResetService,
    /**
     * Global, and order matters: Nest runs multiple APP_GUARD providers in
     * registration order, and OwnershipGuard reads request.user, which only
     * AuthGuard sets. Registering both here rather than per-controller is
     * what makes the default deny: a route added anywhere in the app is
     * closed until someone marks it @Public().
     */
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OwnershipGuard },
  ],
  // PasswordResetService is exported for the admin module (phase 5), which
  // is what actually mints a reset URL — this module only consumes one.
  exports: [SESSION_SECRET, PasswordResetService],
})
export class AuthModule {}
