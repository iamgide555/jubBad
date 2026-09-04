import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { confirmExistingPlayerAlias, createNewPlayer, type Player as FuzzyPlayer } from '../../../fuzzy-match.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(dto: CreateSessionDto): Promise<{ code: string }> {
    const dbPlayers = await this.prisma.player.findMany({ where: { groupId: dto.groupCode } });
    let players: FuzzyPlayer[] = dbPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      aliases: JSON.parse(p.aliases) as string[],
    }));

    const newPlayerWrites: { id: string; name: string }[] = [];
    const aliasWrites = new Map<string, string[]>();

    const resolve = (reviews: NameReviewDto[]): string[] =>
      reviews.map((review) => {
        if (review.match.type === 'exact') {
          return review.match.playerId!;
        }
        if (review.match.type === 'fuzzy' && review.decision === 'accept') {
          players = confirmExistingPlayerAlias(players, review.match.playerId!, review.inputName);
          const updated = players.find((p) => p.id === review.match.playerId)!;
          aliasWrites.set(updated.id, updated.aliases);
          return updated.id;
        }
        const newId = randomUUID();
        players = createNewPlayer(players, newId, review.inputName);
        newPlayerWrites.push({ id: newId, name: review.inputName });
        return newId;
      });

    const rosterPlayerIds = resolve(dto.rosterReviews);
    const waitlistPlayerIds = resolve(dto.waitlistReviews);

    const code = randomUUID().slice(0, 8);

    await this.prisma.$transaction([
      ...newPlayerWrites.map((p) =>
        this.prisma.player.create({
          data: { id: p.id, groupId: dto.groupCode, name: p.name, aliases: '[]' },
        })
      ),
      ...[...aliasWrites.entries()].map(([id, aliases]) =>
        this.prisma.player.update({ where: { id }, data: { aliases: JSON.stringify(aliases) } })
      ),
      this.prisma.session.create({
        data: {
          code,
          groupId: dto.groupCode,
          date: dto.date,
          venue: dto.venue,
          courtCount: dto.courtCount,
          rawImportText: dto.rawImportText,
        },
      }),
      ...rosterPlayerIds.map((playerId) =>
        this.prisma.sessionRoster.create({ data: { sessionId: code, playerId } })
      ),
      ...waitlistPlayerIds.map((playerId, i) =>
        this.prisma.waitlist.create({ data: { sessionId: code, playerId, position: i } })
      ),
    ]);

    return { code };
  }

  async getSession(code: string) {
    const session = await this.prisma.session.findUnique({
      where: { code },
      include: { roster: true, waitlist: { orderBy: { position: 'asc' } }, pairings: true },
    });
    if (!session) throw new NotFoundException();

    const courtCount = session.courtCount ?? 0;
    const courts = Array.from({ length: courtCount }, (_, i) => {
      const courtNumber = i + 1;
      const current = session.pairings
        .filter((p) => p.courtNumber === courtNumber && p.endedAt === null)
        .sort((a, b) => b.matchNumber - a.matchNumber)[0];

      if (!current) return { courtNumber, status: 'idle' as const };

      const teamA = JSON.parse(current.teamA) as [string, string];
      const teamB = JSON.parse(current.teamB) as [string, string];
      return current.confirmedAt
        ? { courtNumber, status: 'active' as const, teamA, teamB }
        : { courtNumber, status: 'pending' as const, teamA, teamB };
    });

    return {
      code: session.code,
      groupCode: session.groupId,
      date: session.date,
      venue: session.venue,
      courtCount: session.courtCount,
      rosterPlayerIds: session.roster.map((r) => r.playerId),
      waitlistPlayerIds: session.waitlist.map((w) => w.playerId),
      courts,
    };
  }
}
