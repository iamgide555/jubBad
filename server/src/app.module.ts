import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

/**
 * AuthModule registers two global APP_GUARDs (AuthGuard, then OwnershipGuard),
 * so importing it here is what closes every route in every other module.
 * Routes opt out with @Public(); see auth/auth.boundary.spec.ts for the list
 * that is allowed to. OwnershipGuard also refuses any non-admin on every
 * /admin route, which is the only thing gating AdminModule.
 */
@Module({
  imports: [AuthModule, PrismaModule, GroupsModule, SessionsModule, AdminModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
