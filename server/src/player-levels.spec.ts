import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './prisma/prisma.module.js';
import { PrismaService } from './prisma/prisma.service.js';
import { levelWrite, loadPlayerLevels, loadRatingAnchors } from './player-levels.js';

describe('levelWrite', () => {
  it('stamps levelSetAt when the level actually changes', () => {
    const before = Date.now();
    const write = levelWrite(null, 'P');
    expect(write.level).toBe('P');
    expect(write.levelSetAt).toBeInstanceOf(Date);
    expect(write.levelSetAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stamps levelSetAt on an edit between two set levels too', () => {
    const write = levelWrite('P', 'C');
    expect(write).toEqual({ level: 'C', levelSetAt: expect.any(Date) });
  });

  it('stamps levelSetAt when clearing a level back to unset', () => {
    const write = levelWrite('P', null);
    expect(write).toEqual({ level: null, levelSetAt: expect.any(Date) });
  });

  it('writes nothing when the level is unchanged — setting the same level again is a no-op', () => {
    expect(levelWrite('P', 'P')).toEqual({});
    expect(levelWrite(null, null)).toEqual({});
  });
});

describe('loadRatingAnchors', () => {
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('seeds an unlevelled player at the plain starting rating with no setAt', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Solo', aliases: '[]' },
    });

    const anchors = await loadRatingAnchors(prisma, code);

    expect(anchors.get(player.id)).toEqual({ rating: 1200, setAt: null });
  });

  it('seeds a leveled player at the level\'s rating, with setAt as epoch ms', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const setAt = new Date('2026-09-23T00:00:00.000Z');
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Leveled', aliases: '[]', level: 'P', levelSetAt: setAt },
    });

    const anchors = await loadRatingAnchors(prisma, code);

    expect(anchors.get(player.id)).toEqual({ rating: 1300, setAt: setAt.getTime() });
  });

  it('treats a level with no levelSetAt (a legacy row) as setAt: null, same as unlevelled', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Legacy', aliases: '[]', level: 'B' },
    });

    const anchors = await loadRatingAnchors(prisma, code);

    expect(anchors.get(player.id)).toEqual({ rating: 1600, setAt: null });
  });
});

describe('loadPlayerLevels', () => {
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('maps every player to their level, null when unset', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const a = await prisma.player.create({ data: { groupId: code, name: 'A', aliases: '[]' } });
    const b = await prisma.player.create({
      data: { groupId: code, name: 'B', aliases: '[]', level: 'S' },
    });

    const levels = await loadPlayerLevels(prisma, code);

    expect(levels.get(a.id)).toBeNull();
    expect(levels.get(b.id)).toBe('S');
  });
});
