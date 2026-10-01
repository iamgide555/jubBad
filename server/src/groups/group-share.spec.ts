import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupShareService, newShareToken } from './group-share.service.js';

describe('newShareToken', () => {
  it('is 22 URL-safe characters (128 bits) and different every time', () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });
});

describe('GroupShareService', () => {
  let service: GroupShareService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupShareService],
    }).compile();
    service = moduleRef.get(GroupShareService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  async function makeGroup() {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'Share' } });
    return code;
  }

  it('reports no token for a group that was never shared', async () => {
    const code = await makeGroup();
    expect(await service.get(code)).toEqual({ token: null });
  });

  it('refuses a group that does not exist', async () => {
    const code = randomUUID();
    await expect(service.get(code)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.enable(code)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disable(code)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enable creates a token, and a second enable returns the same one', async () => {
    const code = await makeGroup();
    const first = await service.enable(code);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await service.enable(code)).toEqual(first);
    expect(await service.get(code)).toEqual(first);
  });

  it('racing enables mint exactly one token', async () => {
    const code = await makeGroup();
    const results = await Promise.all(Array.from({ length: 6 }, () => service.enable(code)));
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
  });

  it('disable clears the token; sharing again mints a different one', async () => {
    const code = await makeGroup();
    const { token: old } = await service.enable(code);
    expect(await service.disable(code)).toEqual({ token: null });
    expect(await service.get(code)).toEqual({ token: null });
    const { token: fresh } = await service.enable(code);
    expect(fresh).not.toBe(old);
  });

  it('tokens are unique across groups', async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    expect((await service.enable(a)).token).not.toBe((await service.enable(b)).token);
  });
});
