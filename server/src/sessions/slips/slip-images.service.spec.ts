import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SlipImagesService } from './slip-images.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ffe000112233', 'hex');
const now = new Date('2026-10-31T00:00:00Z');
const expired = new Date('2026-12-01T00:00:00Z');
describe('SlipImagesService', () => {
  let prisma: PrismaService,
    service: SlipImagesService,
    directory: string,
    group: string,
    code: string,
    other: string;
  const sessionDirectory = (session = code) =>
    join(directory, createHash('sha256').update(session).digest('hex'));
  const files = async (session = code) =>
    readdir(sessionDirectory(session)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'slip-images-'));
    process.env.SLIP_IMAGE_DIR = directory;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    group = randomUUID();
    code = randomUUID();
    other = randomUUID();
    await prisma.group.create({ data: { code: group } });
    await prisma.session.createMany({
      data: [code, other].map((code) => ({
        code,
        groupId: group,
        rawImportText: '',
      })),
    });
    service = new SlipImagesService(prisma);
  });
  afterEach(async () => {
    await service.purgeGroup(group);
    await prisma.session.deleteMany({ where: { groupId: group } });
    await prisma.group.delete({ where: { code: group } });
    await prisma.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });
  it('stores private UUID files, sniffs content and scopes reads and counts', async () => {
    const id = (await service.save(code, '../reference', png, now))!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(sessionDirectory(), id))).toEqual(png);
    expect((await stat(join(sessionDirectory(), id))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(sessionDirectory())).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual([
      createHash('sha256').update(code).digest('hex'),
    ]);
    expect(await service.read(code, id, now)).toEqual({
      image: png,
      contentType: 'image/png',
    });
    expect(await service.read(other, id, now)).toBeNull();
    expect(await service.read(code, '../../etc/passwd', now)).toBeNull();
    expect(await service.list(code, now)).toEqual([
      { id, reference: '../reference' },
    ]);
    expect(await service.list(other, now)).toEqual([]);
    const jpg = (await service.save(other, 'jpg', jpeg, now))!;
    expect((await service.read(other, jpg, now))?.contentType).toBe(
      'image/jpeg',
    );
  });
  it('rejects unsupported bytes without creating metadata or files', async () => {
    expect(
      await service.save(code, 'bad', Buffer.from('fake-image'), now),
    ).toBeNull();
    expect(await service.list(code, now)).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses expiry before sweeping and deletes expired files and metadata', async () => {
    const id = (await service.save(code, 'old', png, now))!;
    expect(await service.read(code, id, expired)).toBeNull();
    expect(await service.list(code, expired)).toEqual([]);
    await service.purge(expired);
    expect(await files()).toEqual([]);
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      0,
    );
  });
  it('reuses valid evidence for a reference retry without leaking files', async () => {
    const id = (await service.save(code, 'same', png, now))!;
    expect(await service.save(code, 'same', jpeg, now)).toBe(id);
    expect(await service.read(code, id, now)).toEqual({
      image: png,
      contentType: 'image/png',
    });
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      1,
    );
    expect(await files()).toEqual([id]);
  });
  it('refreshes missing or expired evidence using its stable id', async () => {
    const id = (await service.save(code, 'same', png, now))!;
    await rm(join(sessionDirectory(), id));
    expect(await service.save(code, 'same', jpeg, now)).toBe(id);
    expect(await service.read(code, id, now)).toEqual({
      image: jpeg,
      contentType: 'image/jpeg',
    });
    expect(await service.save(code, 'same', png, expired)).toBe(id);
    expect(await service.read(code, id, expired)).toEqual({
      image: png,
      contentType: 'image/png',
    });
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      1,
    );
    expect(await files()).toEqual([id]);
  });
  it('preserves existing bytes and metadata if refresh metadata fails', async () => {
    const id = (await service.save(code, 'same', png, now))!;
    const row = await prisma.slipImage.findUniqueOrThrow({ where: { id } });
    const update = vi
      .spyOn(prisma.slipImage, 'update')
      .mockRejectedValueOnce(new Error('metadata failure'));
    await expect(service.save(code, 'same', jpeg, expired)).rejects.toThrow(
      'metadata failure',
    );
    update.mockRestore();
    expect(await prisma.slipImage.findUniqueOrThrow({ where: { id } })).toEqual(
      row,
    );
    expect(await service.read(code, id, now)).toEqual({
      image: png,
      contentType: 'image/png',
    });
    expect(await files()).toEqual([id]);
  });
  it('does not sweep evidence refreshed after the expiry scan', async () => {
    const id = (await service.save(code, 'same', png, now))!;
    const findMany = prisma.slipImage.findMany.bind(prisma.slipImage);
    const scan = vi
      .spyOn(prisma.slipImage, 'findMany')
      .mockImplementationOnce(async (args) => {
        const rows = await findMany(args);
        await service.save(code, 'same', jpeg, expired);
        return rows;
      });
    await service.purge(expired);
    scan.mockRestore();
    expect(await service.read(code, id, expired)).toEqual({
      image: jpeg,
      contentType: 'image/jpeg',
    });
  });
  it('compensates a failed new metadata write', async () => {
    await expect(
      service.save('missing-session', 'new', png, now),
    ).rejects.toThrow();
    expect(await files('missing-session')).toEqual([]);
  });
  it('serializes the group queue and recovers after rejected work', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = service.withGroupLock(group, async () => {
      events.push('first');
      await blocked;
      throw new Error('failed work');
    });
    const failure = expect(first).rejects.toThrow('failed work');
    const second = service.withGroupLock(group, async () => {
      events.push('second');
      return 42;
    });
    await service.withGroupLock('another-group', async () => {
      events.push('independent');
    });
    expect(events).toEqual(['first', 'independent']);
    release();
    await failure;
    expect(await second).toBe(42);
    expect(events).toEqual(['first', 'independent', 'second']);
    expect(await service.withGroupLock(group, async () => 'after')).toBe(
      'after',
    );
  });
  it('purges by reference, session and group and preserves payment and reference records', async () => {
    await prisma.slipReference.create({
      data: {
        groupId: group,
        reference: 'keep',
        bankCode: '004',
        sessionId: code,
      },
    });
    const player = await prisma.player.create({
      data: { groupId: group, name: 'Paid', aliases: '[]' },
    });
    await prisma.sessionPayment.create({
      data: { sessionId: code, playerId: player.id, source: 'host' },
    });
    const first = (await service.save(code, 'first', png, now))!;
    await service.save(code, 'second', png, now);
    await service.save(other, 'other', png, now);
    await rm(join(sessionDirectory(), first));
    await service.removeForReference(code, 'first');
    expect(await service.list(code, now)).toHaveLength(1);
    await service.purgeSession(code);
    expect(await service.list(other, now)).toHaveLength(1);
    await service.purgeGroup(group);
    expect(await readdir(directory)).toEqual([]);
    expect(
      await prisma.sessionPayment.count({ where: { sessionId: code } }),
    ).toBe(1);
    expect(
      await prisma.slipReference.count({ where: { groupId: group } }),
    ).toBe(1);
    await prisma.sessionPayment.deleteMany({ where: { sessionId: code } });
    await prisma.player.delete({ where: { id: player.id } });
  });
  it('removes only old UUID orphans and preserves recent in-flight writes', async () => {
    const old = randomUUID(),
      fresh = randomUUID();
    await mkdir(sessionDirectory(), { recursive: true });
    await writeFile(join(sessionDirectory(), old), png);
    await writeFile(join(sessionDirectory(), fresh), png);
    await writeFile(join(sessionDirectory(), 'unrelated'), png);
    await utimes(join(sessionDirectory(), old), new Date(0), new Date(0));
    await service.purge(new Date());
    expect((await files()).sort()).toEqual([fresh, 'unrelated'].sort());
  });
  it('purges untracked staged and backup files with the whole session directory', async () => {
    await service.save(code, 'retry', png, now);
    await service.save(other, 'other', jpeg, now);
    await writeFile(join(sessionDirectory(), randomUUID()), png);
    await writeFile(join(sessionDirectory(), randomUUID()), jpeg);
    expect(await service.count(code)).toBeGreaterThan(0);
    await service.purgeSession(code);
    expect(await service.count(code)).toBe(0);
    await expect(stat(sessionDirectory())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      0,
    );
    expect(await service.list(other, now)).toHaveLength(1);
  });
  it('retains metadata on recursive deletion failure and retries the whole directory', async () => {
    const id = (await service.save(code, 'retry', png, now))!;
    await writeFile(join(sessionDirectory(), randomUUID()), jpeg);
    vi.mocked(rm).mockRejectedValueOnce(new Error('filesystem failure'));
    await expect(service.purgeSession(code)).rejects.toThrow(
      'filesystem failure',
    );
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      1,
    );
    expect(await service.read(code, id, now)).toEqual({
      image: png,
      contentType: 'image/png',
    });
    await service.purgeSession(code);
    await expect(stat(sessionDirectory())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await prisma.slipImage.count({ where: { sessionId: code } })).toBe(
      0,
    );
  });
});
