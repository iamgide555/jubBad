/**
 * Numbered, reusable shuttles (host feedback D). The pure types and helpers
 * live here so the persistence layer, the lifecycle and the aggregates all
 * speak the same shapes. Nothing in this file touches Prisma.
 */

/** The host's choice when a game starts or its shuttle changes. */
export type ShuttleChoice = { kind: 'new' } | { kind: 'existing'; shuttleId: string };

/** A shuttle as clients see it: the id for writes, the number for display. */
export interface ShuttleRef {
  id: string;
  number: number;
}
