import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

/**
 * AuthModule registers a global APP_GUARD, so importing it here is what closes
 * every route in every other module. Routes opt out with @Public(); see
 * auth/auth.boundary.spec.ts for the list that is allowed to.
 */
@Module({
  imports: [AuthModule, PrismaModule, GroupsModule, SessionsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
