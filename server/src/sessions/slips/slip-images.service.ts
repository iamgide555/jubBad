import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Prisma, SlipImage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

@Injectable()
export class SlipImagesService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly directory = resolve(
    process.env.SLIP_IMAGE_DIR || 'prisma/slip-images',
  );
  private readonly logger = new Logger(SlipImagesService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly activeFiles = new Set<string>();
  private readonly groupTails = new Map<string, Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  /** Acquire this before the session lock when work also touches group state. */
  withGroupLock<T>(groupCode: string, work: () => Promise<T>): Promise<T> {
    const previous = this.groupTails.get(groupCode) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.groupTails.set(groupCode, tail);
    void tail.then(() => {
      if (this.groupTails.get(groupCode) === tail)
        this.groupTails.delete(groupCode);
    });
    return result;
  }

  onApplicationBootstrap(): void {
    const sweep = async () => {
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        await this.purge();
      } catch (error) {
        this.logger.error('Slip image cleanup failed', error);
      } finally {
        this.sweeping = false;
      }
    };
    void sweep();
    this.timer = setInterval(() => void sweep(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async save(
    code: string,
    reference: string,
    image: Buffer,
    now = new Date(),
  ): Promise<string | null> {
    const contentType = this.contentType(image);
    if (!contentType) return null;
    await this.ensureDirectory(code);
    const existing = await this.prisma.slipImage.findUnique({
      where: { sessionId_reference: { sessionId: code, reference } },
    });
    if (existing) {
      if (existing.expiresAt > now) {
        try {
          const stored = await readFile(this.path(code, existing.id));
          if (this.contentType(stored) === existing.contentType)
            return existing.id;
        } catch (error) {
          if (
            !this.isMissing(error) &&
            (error as NodeJS.ErrnoException).code !== 'EACCES'
          )
            throw error;
        }
      }
      await this.refresh(existing, image, contentType, now);
      return existing.id;
    }
    const id = randomUUID();
    const path = this.path(code, id);
    try {
      await writeFile(path, image, { mode: 0o600, flag: 'wx' });
      await this.prisma.slipImage.create({
        data: {
          id,
          sessionId: code,
          reference,
          contentType,
          createdAt: now,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      });
    } catch (error) {
      await this.removeFile(code, id);
      throw error;
    }
    return id;
  }

  async read(
    code: string,
    id: string,
    now = new Date(),
  ): Promise<{ image: Buffer; contentType: string } | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.slipImage.findFirst({
      where: { id, sessionId: code, expiresAt: { gt: now } },
    });
    if (!row) return null;
    try {
      return {
        image: await readFile(this.path(code, id)),
        contentType: row.contentType,
      };
    } catch (error) {
      if (this.isMissing(error)) return null;
      throw error;
    }
  }

  async list(
    code: string,
    now = new Date(),
  ): Promise<{ id: string; reference: string }[]> {
    return this.prisma.slipImage.findMany({
      where: { sessionId: code, expiresAt: { gt: now } },
      select: { id: true, reference: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Count actual bytes on disk, including crash leftovers, so close can always offer cleanup retry. */
  async count(code: string): Promise<number> {
    try { return (await readdir(this.sessionDirectory(code), {withFileTypes:true})).filter((entry) => entry.isFile()).length; }
    catch (error) { if (this.isMissing(error)) return 0; throw error; }
  }

  async removeForReference(code: string, reference: string): Promise<void> {
    await this.removeRows({ sessionId: code, reference });
  }

  async purgeSession(code: string): Promise<void> {
    // Delete all bytes, including untracked crash/staging leftovers, before
    // removing metadata. A failed recursive delete remains retryable by close.
    await rm(this.sessionDirectory(code), { recursive: true, force: true });
    await this.prisma.slipImage.deleteMany({ where: { sessionId: code } });
  }

  async purgeGroup(groupCode: string): Promise<void> {
    const sessions = await this.prisma.session.findMany({
      where: { groupId: groupCode },
      select: { code: true },
    });
    for (const session of sessions) await this.purgeSession(session.code);
  }

  async purge(now = new Date()): Promise<void> {
    const expired = await this.prisma.slipImage.findMany({
      where: { expiresAt: { lte: now } },
      include: { session: { select: { groupId: true } } },
    });
    for (const candidate of expired) {
      await this.withGroupLock(candidate.session.groupId, async () => {
        const row = await this.prisma.slipImage.findFirst({
          where: { id: candidate.id, expiresAt: { lte: now } },
        });
        if (row) await this.removeRow(row);
      });
    }
    let directories;
    try {
      directories = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (this.isMissing(error)) return;
      throw error;
    }
    const sessions = await this.prisma.session.findMany({
      select: { code: true, groupId: true },
    });
    const byHash = new Map(
      sessions.map((session) => [this.sessionHash(session.code), session]),
    );
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^[0-9a-f]{64}$/.test(directory.name))
        continue;
      const session = byHash.get(directory.name);
      const sweep = () =>
        this.purgeOrphans(
          join(this.directory, directory.name),
          session?.code,
          now,
        );
      if (session) await this.withGroupLock(session.groupId, sweep);
      else await sweep();
    }
  }

  private async purgeOrphans(
    directory: string,
    code: string | undefined,
    now: Date,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (this.isMissing(error)) return;
      throw error;
    }
    for (const id of names) {
      if (!UUID.test(id) || this.activeFiles.has(id)) continue;
      const path = join(directory, id);
      try {
        const file = await stat(path);
        // Give uncommitted writes a full hour before treating them as orphans.
        if (!file.isFile() || file.mtimeMs > now.getTime() - SWEEP_MS) continue;
        const row = code
          ? await this.prisma.slipImage.findFirst({
              where: { id, sessionId: code },
              select: { id: true },
            })
          : null;
        if (!row) await unlink(path);
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }
  }

  private contentType(image: Buffer): string | null {
    if (image.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
    if (
      image.length >= 3 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff
    )
      return 'image/jpeg';
    return null;
  }

  private async refresh(
    row: SlipImage,
    image: Buffer,
    contentType: string,
    now: Date,
  ): Promise<void> {
    const stagedId = randomUUID();
    const backupId = randomUUID();
    const active = [row.id, stagedId, backupId];
    for (const id of active) this.activeFiles.add(id);
    try {
      let originalMoved = false;
      let replacementInstalled = false;
      try {
        // Stage with private permissions before touching the existing evidence.
        await writeFile(this.path(row.sessionId, stagedId), image, {
          mode: 0o600,
          flag: 'wx',
        });
        try {
          const original = await stat(this.path(row.sessionId, row.id));
          if (!original.isFile())
            throw new Error('Slip image path is not a file');
          await rename(
            this.path(row.sessionId, row.id),
            this.path(row.sessionId, backupId),
          );
          originalMoved = true;
        } catch (error) {
          if (!this.isMissing(error)) throw error;
        }
        await rename(
          this.path(row.sessionId, stagedId),
          this.path(row.sessionId, row.id),
        );
        replacementInstalled = true;
        await this.prisma.slipImage.update({
          where: { id: row.id },
          data: {
            contentType,
            expiresAt: new Date(now.getTime() + RETENTION_MS),
          },
        });
      } catch (error) {
        if (originalMoved) {
          await rename(
            this.path(row.sessionId, backupId),
            this.path(row.sessionId, row.id),
          );
        } else if (replacementInstalled) {
          await this.removeFile(row.sessionId, row.id);
        }
        throw error;
      } finally {
        await this.removeFile(row.sessionId, stagedId);
      }
      if (originalMoved) {
        // Metadata and replacement are committed. An old backup may be swept as
        // an orphan if its unlink fails; do not turn a successful save into failure.
        try {
          await this.removeFile(row.sessionId, backupId);
        } catch (error) {
          this.logger.warn('Old slip image backup cleanup failed', error);
        }
      }
    } finally {
      for (const id of active) this.activeFiles.delete(id);
    }
  }

  private async ensureDirectory(code: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await mkdir(this.sessionDirectory(code), { recursive: true, mode: 0o700 });
    await chmod(this.sessionDirectory(code), 0o700);
  }

  private sessionHash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private sessionDirectory(code: string): string {
    return join(this.directory, this.sessionHash(code));
  }

  private path(code: string, id: string): string {
    if (!UUID.test(id)) throw new Error('Invalid slip image identifier');
    return join(this.sessionDirectory(code), id);
  }

  private async removeRows(where: Prisma.SlipImageWhereInput): Promise<void> {
    const rows = await this.prisma.slipImage.findMany({ where });
    for (const row of rows) await this.removeRow(row);
  }

  private async removeRow(row: SlipImage): Promise<void> {
    await this.removeFile(row.sessionId, row.id);
    // Keep metadata if unlink fails, so the next sweep can retry.
    await this.prisma.slipImage.deleteMany({ where: { id: row.id } });
  }

  private async removeFile(code: string, id: string): Promise<void> {
    try {
      await unlink(this.path(code, id));
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}
