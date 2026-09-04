import { Injectable, NotFoundException } from '@nestjs/common';
import { matchRoster } from '../../../fuzzy-match.ts';
import { parseLineRosterMessage } from '../../../parser.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateGroupDto } from './dto/update-group.dto.js';
import type { ParseRosterDto } from './dto/parse-roster.dto.js';

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const lastSession = await this.prisma.session.findFirst({
      where: { groupId: code },
      orderBy: { createdAt: 'desc' },
      select: { code: true },
    });

    return { code: group.code, name: group.name, lastSessionCode: lastSession?.code ?? null };
  }

  async update(code: string, dto: UpdateGroupDto) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const updated = await this.prisma.group.update({
      where: { code },
      data: { name: dto.name },
    });
    return { code: updated.code, name: updated.name };
  }

  async listPlayers(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    return players.map((p) => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases) as string[] }));
  }

  async parse(code: string, dto: ParseRosterDto) {
    await this.prisma.group.upsert({
      where: { code },
      create: { code, name: dto.groupName },
      update: {},
    });

    const result = parseLineRosterMessage(dto.rawText);
    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    const fuzzyPlayers = players.map((p) => ({
      id: p.id,
      name: p.name,
      aliases: JSON.parse(p.aliases) as string[],
    }));

    const rosterNames = result.roster.map((s) => s.name).filter((n): n is string => n !== null);
    const waitlistNames = result.waitlist.map((s) => s.name).filter((n): n is string => n !== null);

    return {
      header: {
        isoDate: result.header.isoDate,
        venue: result.header.venue,
        courtCount: result.header.timeSlots[0]?.courtCount ?? null,
      },
      rosterReviews: matchRoster(rosterNames, fuzzyPlayers),
      waitlistReviews: matchRoster(waitlistNames, fuzzyPlayers),
      warnings: result.warnings,
      unrecognizedLines: result.unrecognizedLines,
    };
  }
}
