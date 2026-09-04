import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { confirmExistingPlayerAlias, createNewPlayer, type Player as FuzzyPlayer } from '../../../fuzzy-match.ts';
import { generateRound } from '../../../pairing.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { deriveHistory } from './derive-history.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';
import type { FinishPairingDto } from './dto/finish-pairing.dto.js';

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
        ? { courtNumber, status: 'active' as const, pairingId: current.id, teamA, teamB }
        : { courtNumber, status: 'pending' as const, pairingId: current.id, teamA, teamB };
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

  async propose(sessionCode: string, courtNumber: number) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw new NotFoundException();

    const roster = await this.prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });
    const reserved = new Set<string>();
    let existingPending: (typeof nonEnded)[number] | undefined;
    for (const p of nonEnded) {
      if (p.courtNumber === courtNumber) {
        if (p.confirmedAt === null) existingPending = p;
        continue;
      }
      const [a1, a2] = JSON.parse(p.teamA) as [string, string];
      const [b1, b2] = JSON.parse(p.teamB) as [string, string];
      reserved.add(a1);
      reserved.add(a2);
      reserved.add(b1);
      reserved.add(b2);
    }
    const available = rosterPlayerIds.filter((id) => !reserved.has(id));

    const confirmed = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: { not: null } },
    });
    const history = deriveHistory(
      confirmed.map((p) => ({
        teamA: JSON.parse(p.teamA) as [string, string],
        teamB: JSON.parse(p.teamB) as [string, string],
      }))
    );

    const avoidSplit = existingPending
      ? {
          teamA: JSON.parse(existingPending.teamA) as [string, string],
          teamB: JSON.parse(existingPending.teamB) as [string, string],
        }
      : undefined;

    const result = generateRound(available, 1, history, undefined, avoidSplit);
    if (result.courts.length === 0) {
      return { ok: false as const, reason: 'not-enough-players' as const };
    }
    const [proposed] = result.courts;
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    const pairing = existingPending
      ? await this.prisma.pairing.update({
          where: { id: existingPending.id },
          data: { teamA, teamB },
        })
      : await this.prisma.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber,
            matchNumber:
              (await this.prisma.pairing.count({
                where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
              })) + 1,
            teamA,
            teamB,
          },
        });

    return {
      ok: true as const,
      pairing: {
        id: pairing.id,
        courtNumber: pairing.courtNumber,
        matchNumber: pairing.matchNumber,
        teamA: proposed.teamA,
        teamB: proposed.teamB,
      },
    };
  }

  async confirmPairing(id: string) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) throw new NotFoundException();
    return this.prisma.pairing.update({ where: { id }, data: { confirmedAt: new Date() } });
  }

  async finishPairing(id: string, dto: FinishPairingDto) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) throw new NotFoundException();
    return this.prisma.pairing.update({
      where: { id },
      data: { endedAt: new Date(), scoreA: dto.scoreA, scoreB: dto.scoreB },
    });
  }
}
