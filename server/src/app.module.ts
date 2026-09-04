import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
  imports: [PrismaModule, GroupsModule, SessionsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
