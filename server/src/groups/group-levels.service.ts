import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { validateLevelSpecs } from '../../../engines/levels.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionLock } from '../sessions/session-lock.js';
import type { SaveGroupLevelsDto } from './dto/save-group-levels.dto.js';
import {
  LevelLadderCorruptError,
  parseGroupLadder,
  serializeGroupLadder,
  type StoredLevel,
} from './group-levels.js';

export interface GroupLevelsView {
  mode: 'standard' | 'custom';
  revision: number;
  levels: { id: string; name: string; startingElo: number }[];
  /** Players assigned to each level id, zeros included. */
  assignedCounts: Record<string, number>;
}

/**
 * A group's own skill ladder (host feedback F): reads it, and edits it under a
 * group-scoped lock that session creation and level assignments share, so a
 * session or a newly tagged player can never appear between a save's guard and
 * its commit. Owner-only by the global guards.
 */
@Injectable()
export class GroupLevelsService {
  /** Keyed by group code; the same non-reentrant queue the session code uses. */
  private readonly lock = new SessionLock();

  constructor(private readonly prisma: PrismaService) {}

  withGroupLock<T>(groupCode: string, work: () => Promise<T>): Promise<T> {
    return this.lock.run(groupCode, work);
  }

  /** The effective ladder. Corrupt stored data throws; it is never read as the standard ladder. */
  async loadLadder(groupCode: string) {
    const group = await this.prisma.group.findUnique({ where: { code: groupCode } });
    if (!group) throw new NotFoundException();
    return this.ladderOf(group);
  }

  /** The effective ladder of an already-loaded group row (also usable inside a transaction). */
  ladderOf(group: { levelLadder: string | null; levelLadderRevision: number }) {
    try {
      return { ...parseGroupLadder(group.levelLadder), revision: group.levelLadderRevision };
    } catch (e) {
      if (e instanceof LevelLadderCorruptError) {
        throw new InternalServerErrorException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }

  async get(groupCode: string): Promise<GroupLevelsView> {
    const ladder = await this.loadLadder(groupCode);
    const players = await this.prisma.player.findMany({ where: { groupId: groupCode }, select: { id: true, level: true } });
    return this.view(ladder, players);
  }

  private view(
    ladder: { mode: 'standard' | 'custom'; revision: number; levels: readonly StoredLevel[] },
    players: { id: string; level: string | null }[]
  ): GroupLevelsView {
    const idByName = new Map(ladder.levels.map((l) => [l.name, l.id]));
    const assignedCounts: Record<string, number> = Object.fromEntries(ladder.levels.map((l) => [l.id, 0]));
    const unknown: string[] = [];
    for (const p of players) {
      if (p.level === null) continue;
      const id = idByName.get(p.level);
      if (id === undefined) unknown.push(p.id);
      else assignedCounts[id] += 1;
    }
    // A label the ladder does not contain is a data fault to report, not an untagged player.
    if (unknown.length > 0) throw new InternalServerErrorException({ code: 'LEVEL_DATA_INTEGRITY', playerIds: unknown });
    return {
      mode: ladder.mode,
      revision: ladder.revision,
      levels: ladder.levels.map((l) => ({ id: l.id, name: l.name, startingElo: l.startingElo })),
      assignedCounts,
    };
  }

  /** The revision the host saw must be the current one; checked first so an old tab cannot reapply a cleared label. */
  assertRevision(ladder: { revision: number }, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined || expectedRevision !== ladder.revision) {
      throw new ConflictException({ code: 'LEVEL_LADDER_STALE', revision: ladder.revision });
    }
  }

  /** Every chosen name must be in this group's ladder. */
  assertNames(ladder: { levels: readonly { name: string }[] }, names: readonly string[]): void {
    const known = new Set(ladder.levels.map((l) => l.name));
    const unknown = [...new Set(names.filter((n) => !known.has(n)))];
    if (unknown.length > 0) throw new BadRequestException({ code: 'LEVEL_UNKNOWN', levels: unknown });
  }

  /**
   * Gate for a level-bearing write that carries a choice: revision, then names,
   * before anything is written. No choices means nothing to guard.
   */
  assertWritable(
    ladder: { revision: number; levels: readonly { name: string }[] },
    expectedRevision: number | undefined,
    names: readonly string[]
  ): void {
    if (names.length === 0) return;
    this.assertRevision(ladder, expectedRevision);
    this.assertNames(ladder, names);
  }

  save(groupCode: string, dto: SaveGroupLevelsDto): Promise<GroupLevelsView> {
    return this.withGroupLock(groupCode, () => this.saveExclusively(groupCode, dto));
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: 'LEVEL_LADDER_INVALID', message });
  }

  private async saveExclusively(groupCode: string, dto: SaveGroupLevelsDto): Promise<GroupLevelsView> {
    await this.prisma.$transaction(async (tx) => {
      const group = await tx.group.findUnique({ where: { code: groupCode } });
      if (!group) throw new NotFoundException();
      if (dto.expectedRevision !== group.levelLadderRevision) {
        throw new ConflictException({ code: 'LEVEL_LADDER_STALE', revision: group.levelLadderRevision });
      }
      // Rechecked here, inside the lock and the transaction: any session not yet ended
      // (including one nobody has started) blocks every action.
      const open = await tx.session.count({ where: { groupId: groupCode, endedAt: null } });
      if (open > 0) throw new ConflictException({ code: 'LEVEL_LADDER_ACTIVE_SESSION' });

      const current = this.ladderOf(group);
      const players = await tx.player.findMany({ where: { groupId: groupCode }, select: { id: true, level: true } });
      const submitted = dto.levels ?? [];
      let nextLadder: string | null;

      if (dto.action === 'reset') {
        if (current.mode !== 'custom') throw this.invalid('the group already uses the standard ladder');
        if (dto.levels !== undefined) throw this.invalid('reset takes no levels');
        nextLadder = null;
        await tx.player.updateMany({ where: { groupId: groupCode, level: { not: null } }, data: { level: null } });
      } else if (dto.action === 'customize') {
        if (current.mode !== 'standard') throw this.invalid('the group already has a custom ladder; edit it instead');
        if (submitted.some((l) => l.id !== undefined)) throw this.invalid('new levels must not carry ids');
        const levels: StoredLevel[] = submitted.map((l) => ({ id: randomUUID(), name: l.name, startingElo: l.startingElo }));
        this.validate(levels);
        nextLadder = serializeGroupLadder(levels);
        // Labels only: a different grading system, so old labels are never guessed to mean the new ones.
        // levelSeed, levelSetAt and every match stay exactly as they were.
        await tx.player.updateMany({ where: { groupId: groupCode, level: { not: null } }, data: { level: null } });
      } else {
        if (current.mode !== 'custom') throw this.invalid('edit applies to a custom ladder; customize first');
        const known = new Map(current.levels.map((l) => [l.id, l]));
        const seen = new Set<string>();
        for (const l of submitted) {
          if (l.id === undefined) continue;
          if (!known.has(l.id)) throw this.invalid(`unknown level id "${l.id}"`);
          if (seen.has(l.id)) throw this.invalid(`level id "${l.id}" appears twice`);
          seen.add(l.id);
        }
        const levels: StoredLevel[] = submitted.map((l) => ({ id: l.id ?? randomUUID(), name: l.name, startingElo: l.startingElo }));
        this.validate(levels);

        const idByOldName = new Map(current.levels.map((l) => [l.name, l.id]));
        const counts: Record<string, number> = {};
        const unknown: string[] = [];
        const original = new Map<string, string | null>(); // player id -> level name BEFORE any write
        for (const p of players) {
          original.set(p.id, p.level);
          if (p.level === null) continue;
          const id = idByOldName.get(p.level);
          if (id === undefined) unknown.push(p.id);
          else if (!seen.has(id)) counts[id] = (counts[id] ?? 0) + 1;
        }
        if (unknown.length > 0) throw new InternalServerErrorException({ code: 'LEVEL_DATA_INTEGRITY', playerIds: unknown });
        // Removal is only ever allowed for a level nobody has; the host reassigns or clears people first.
        if (Object.keys(counts).length > 0) throw new ConflictException({ code: 'LEVEL_IN_USE', counts });

        // Renames come from the snapshot above, so two names swapped in one save both migrate.
        const newNameById = new Map(levels.map((l) => [l.id, l.name]));
        for (const [playerId, oldName] of original) {
          if (oldName === null) continue;
          const nextName = newNameById.get(idByOldName.get(oldName)!)!;
          if (nextName !== oldName) await tx.player.update({ where: { id: playerId }, data: { level: nextName } });
        }
        nextLadder = serializeGroupLadder(levels);
      }

      await tx.group.update({
        where: { code: groupCode },
        data: { levelLadder: nextLadder, levelLadderRevision: { increment: 1 } },
      });
    });
    return this.get(groupCode);
  }

  private validate(levels: StoredLevel[]): void {
    try {
      validateLevelSpecs(levels);
    } catch (e) {
      throw this.invalid((e as Error).message);
    }
  }
}
