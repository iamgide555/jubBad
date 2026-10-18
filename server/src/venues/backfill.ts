import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeVenueName } from '../../../engines/venues.ts';

/**
 * One-off link of one host's old sessions to the shared venue list. Not part of
 * the schema migration, which backfills nothing: only the named groups, owned
 * by the named host, are touched, and every session in them is set to the
 * venue mapped to the group, overwriting whatever venue text it had. Every
 * other group keeps its text and stays unlinked; its venue joins the list when
 * its next session is created. Safe to run twice.
 */
export interface GroupVenue {
  groupName: string;
  venueName: string;
}

export interface BackfillOptions {
  ownerEmail: string;
  groupVenues: GroupVenue[];
  dryRun: boolean;
}

export interface BackfillReport {
  ownerFound: boolean;
  venuesCreated: number;
  venuesReused: number;
  sessionsLinked: number;
  sessionTextsOverwritten: number;
  unmatchedGroupNames: string[];
  dryRun: boolean;
}

const sameText = (a: string, b: string) => a.trim().normalize('NFC').toLowerCase() === b.trim().normalize('NFC').toLowerCase();

export async function backfillVenues(prisma: PrismaService, opts: BackfillOptions): Promise<BackfillReport> {
  for (const m of opts.groupVenues) {
    if (normalizeVenueName(m.venueName) === '') {
      throw new Error(`blank venue name for group "${m.groupName}"`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const owner = (await tx.user.findMany({ select: { id: true, email: true } })).find((u) =>
      sameText(u.email, opts.ownerEmail)
    );
    if (!owner) throw new Error(`owner not found: ${opts.ownerEmail}`);

    const owned = await tx.group.findMany({ where: { ownerId: owner.id }, select: { code: true, name: true } });
    const report: BackfillReport = {
      ownerFound: true,
      venuesCreated: 0,
      venuesReused: 0,
      sessionsLinked: 0,
      sessionTextsOverwritten: 0,
      unmatchedGroupNames: [],
      dryRun: opts.dryRun,
    };
    // A venue two mappings share is counted once.
    const counted = new Set<string>();

    for (const mapping of opts.groupVenues) {
      const codes = owned
        .filter((g) => g.name !== null && sameText(g.name, mapping.groupName))
        .map((g) => g.code);
      if (codes.length === 0) {
        report.unmatchedGroupNames.push(mapping.groupName);
        continue;
      }

      const venueName = mapping.venueName.trim();
      const normalizedName = normalizeVenueName(venueName);
      const existing = await tx.venue.findUnique({ where: { normalizedName } });
      if (!counted.has(normalizedName)) {
        counted.add(normalizedName);
        if (existing) report.venuesReused += 1;
        else report.venuesCreated += 1;
      }

      const sessions = await tx.session.findMany({
        where: { groupId: { in: codes } },
        select: { venue: true, venueId: true },
      });
      report.sessionsLinked += sessions.filter((s) => s.venueId === null || s.venueId !== existing?.id).length;
      report.sessionTextsOverwritten += sessions.filter((s) => s.venue !== venueName).length;

      if (!opts.dryRun) {
        const venue = await tx.venue.upsert({
          where: { normalizedName },
          create: { displayName: venueName, normalizedName },
          update: {},
        });
        await tx.session.updateMany({
          where: { groupId: { in: codes } },
          data: { venueId: venue.id, venue: venueName },
        });
      }
    }

    return report;
  });
}
