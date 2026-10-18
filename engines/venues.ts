/**
 * Venue name matching for the shared venue list. Same rule as fuzzy player
 * matching (see fuzzy-match.ts): only an exact normalized match links; anything
 * merely similar is a suggestion the host taps. A missed suggestion makes a
 * duplicate venue (recoverable); a wrong merge cannot be undone.
 */
import { similarity } from './fuzzy-match.ts';

export interface VenueRef {
  id: string;
  displayName: string;
  normalizedName: string;
}

export interface VenueMatches {
  exact: VenueRef | null;
  suggestions: VenueRef[];
}

/**
 * Venues run longer than Thai nicknames, so one edit costs less similarity and
 * the bar sits above the player threshold (0.5).
 */
export const VENUE_SUGGEST_THRESHOLD = 0.6;

const DEFAULT_LIMIT = 8;

/** NFC, lowercase, all whitespace removed — Thai is often typed without spaces. */
export function normalizeVenueName(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

export function matchVenues(typed: string, venues: VenueRef[], limit = DEFAULT_LIMIT): VenueMatches {
  const query = normalizeVenueName(typed);
  if (query === '') return { exact: null, suggestions: [] };

  const exact = venues.find((v) => v.normalizedName === query) ?? null;
  const scored = venues
    .filter((v) => v !== exact)
    .map((v) => ({
      venue: v,
      substring: v.normalizedName.includes(query),
      score: similarity(query, v.normalizedName),
    }))
    .filter((m) => m.substring || m.score >= VENUE_SUGGEST_THRESHOLD);

  scored.sort(
    (a, b) =>
      Number(b.substring) - Number(a.substring) ||
      b.score - a.score ||
      a.venue.displayName.localeCompare(b.venue.displayName)
  );

  return { exact, suggestions: scored.slice(0, limit).map((m) => m.venue) };
}
