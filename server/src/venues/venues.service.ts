import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchVenues, normalizeVenueName } from '../../../engines/venues.ts';

export interface VenueOption {
  id: string;
  displayName: string;
}

export interface VenueSearchResult {
  exact: VenueOption | null;
  suggestions: VenueOption[];
}

const toOption = (v: VenueOption): VenueOption => ({ id: v.id, displayName: v.displayName });

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Scans the whole list per request: it is one row per physical venue across
   * every host, small enough that an in-memory match beats a second index.
   */
  async search(query: string): Promise<VenueSearchResult> {
    if (normalizeVenueName(query) === '') return { exact: null, suggestions: [] };
    const venues = await this.prisma.venue.findMany();
    const { exact, suggestions } = matchVenues(query, venues);
    return { exact: exact && toOption(exact), suggestions: suggestions.map(toOption) };
  }

  /**
   * The venue id for a typed name: the existing venue when the normalized name
   * matches exactly, else a new one. Never links a merely similar name. Upsert
   * on the unique normalized name so two hosts adding the same new venue at once
   * end up on one row.
   */
  async findOrCreate(tx: Prisma.TransactionClient, rawName: string | null | undefined): Promise<string | null> {
    // The create DTO's venue is optional, so a client that omits it sends undefined.
    if (rawName == null) return null;
    const normalizedName = normalizeVenueName(rawName);
    if (normalizedName === '') return null;
    const venue = await tx.venue.upsert({
      where: { normalizedName },
      create: { displayName: rawName.trim(), normalizedName },
      update: {},
    });
    return venue.id;
  }
}
