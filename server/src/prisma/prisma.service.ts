import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // Multiple PrismaService instances (one per NestJS TestingModule in the
    // test suite) open separate connections to the same physical SQLite
    // file. The default rollback-journal mode serializes writers and throws
    // SQLITE_BUSY under concurrent write load - observed intermittently once
    // enough spec files ran concurrently. WAL mode allows concurrent
    // readers alongside a single writer; busy_timeout makes a writer wait
    // for a lock instead of failing immediately.
    await this.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
    await this.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
