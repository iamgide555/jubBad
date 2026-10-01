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

/**
 * Checks which fields go with which kind of choice: `existing` needs a
 * shuttleId, `new` must not carry one. Returns the narrowed choice, or null
 * when the shape is inconsistent (the caller answers 400).
 */
export function parseShuttleChoice(input: { kind: 'new' | 'existing'; shuttleId?: string }): ShuttleChoice | null {
  if (input.kind === 'new') return input.shuttleId === undefined ? { kind: 'new' } : null;
  if (input.kind === 'existing' && typeof input.shuttleId === 'string' && input.shuttleId.length > 0) {
    return { kind: 'existing', shuttleId: input.shuttleId };
  }
  return null;
}
