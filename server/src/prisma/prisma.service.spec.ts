import { Test } from '@nestjs/testing';
import { PrismaModule } from './prisma.module.js';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it('connects and can run a real query', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const prisma = app.get(PrismaService);
    // better-sqlite3's driver adapter returns SQLite integers as BigInt.
    const result = await prisma.$queryRaw<{ result: bigint }[]>`SELECT 1 as result`;
    expect(result[0].result).toBe(1n);

    await app.close();
  });
});
