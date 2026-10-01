/** Mirrors server/src/sessions/shuttle-tracking.ts — the host's choice for a game's shuttle. */
export type ShuttleChoice = { kind: 'new' } | { kind: 'existing'; shuttleId: string };

/** A shuttle as the API names it: the id for writes, the number for display. */
export interface ShuttleRef {
  id: string;
  number: number;
}

export interface ShuttleIdentity extends ShuttleRef {
  /** False means retired: it stays in history and can be restored. */
  usable: boolean;
  voided: boolean;
}

/** The owner-only inventory read (GET /sessions/:code/shuttles). */
export interface ShuttleInventory {
  /** False on an ordinary session — the read then only proves ownership. */
  enabled: boolean;
  identities: ShuttleIdentity[];
  /** Finished games, each with the revision a correction must send; null ids = unknown log. */
  games: { pairingId: string; revision: number; shuttleIds: string[] | null }[];
  /** Shuttles in a live hand right now — not idle, so not offered to another court. */
  heldShuttleIds: string[];
  /** Each court's suggestion: the last shuttle of its most recent finished game. */
  lastShuttleByCourt: { courtNumber: number; shuttleId: string }[];
}

const ref = (s: ShuttleIdentity): ShuttleRef => ({ id: s.id, number: s.number });

/**
 * Shuttles a host may take for a live game: usable, unvoided and idle, in
 * number order. `keepId` stays selectable even while held (the court's own
 * shuttle); `exceptId` is left out (the one being switched away from).
 */
export function pickableShuttles(
  inventory: ShuttleInventory,
  keepId?: string,
  exceptId?: string
): ShuttleRef[] {
  if (!inventory.enabled) return [];
  const held = new Set(inventory.heldShuttleIds);
  return inventory.identities
    .filter((s) => s.usable && !s.voided && s.id !== exceptId && (!held.has(s.id) || s.id === keepId))
    .sort((a, b) => a.number - b.number)
    .map(ref);
}

/** The court's last shuttle, only when it can actually be reused right now. */
export function lastShuttleFor(inventory: ShuttleInventory, courtNumber: number): ShuttleRef | null {
  const last = inventory.lastShuttleByCourt.find((c) => c.courtNumber === courtNumber);
  if (!last) return null;
  const shuttle = inventory.identities.find((s) => s.id === last.shuttleId);
  if (!shuttle || !shuttle.usable || shuttle.voided) return null;
  return inventory.heldShuttleIds.includes(shuttle.id) ? null : ref(shuttle);
}
