/**
 * Matches parsed roster/waitlist names against known Player records for a
 * group. Exact match (post-normalize) auto-links; fuzzy match only ever
 * surfaces as a suggestion — never auto-links. See docs/overview.md, "How the
 * engines think — Fuzzy matching".
 */

const TRAILING_PAREN_NOTE_RE = /\s*\([^)]*\)\s*$/;

export function normalizeName(name: string): string {
  return name.replace(TRAILING_PAREN_NOTE_RE, '').trim().normalize('NFC');
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

export interface Player {
  id: string;
  name: string;
  aliases: string[];
}

export type NameMatch =
  | { type: 'exact'; playerId: string }
  | { type: 'fuzzy'; playerId: string; score: number }
  | { type: 'new' };

/**
 * Above this, a near-miss is worth *suggesting* to the host — never
 * auto-linking. Normalized Levenshtein rather than bigram/Dice similarity
 * because Thai nicknames here run 2-4 characters (ปอม, ตี๋, เบส), where one
 * edit destroys most bigrams. The namespace is small and dense enough that
 * near-misses are often genuinely different people — เกีย and เกียร์ are two
 * different players in the real example messages — so a wrong silent merge is
 * the failure mode to avoid.
 */
const FUZZY_THRESHOLD = 0.7;

export function matchName(inputName: string, players: Player[]): NameMatch {
  const normalizedInput = normalizeName(inputName);

  for (const player of players) {
    const candidates = [player.name, ...player.aliases];
    if (candidates.some((c) => normalizeName(c) === normalizedInput)) {
      return { type: 'exact', playerId: player.id };
    }
  }

  let bestPlayerId: string | null = null;
  let bestScore = 0;
  for (const player of players) {
    const candidates = [player.name, ...player.aliases];
    for (const candidate of candidates) {
      const score = similarity(normalizedInput, normalizeName(candidate));
      if (score > bestScore) {
        bestScore = score;
        bestPlayerId = player.id;
      }
    }
  }

  if (bestPlayerId !== null && bestScore >= FUZZY_THRESHOLD) {
    return { type: 'fuzzy', playerId: bestPlayerId, score: bestScore };
  }

  return { type: 'new' };
}

export interface RosterNameMatch {
  inputName: string;
  match: NameMatch;
}

export function matchRoster(names: string[], players: Player[]): RosterNameMatch[] {
  return names.map((inputName) => ({ inputName, match: matchName(inputName, players) }));
}

export function confirmExistingPlayerAlias(
  players: Player[],
  playerId: string,
  rawInputName: string
): Player[] {
  return players.map((player) => {
    if (player.id !== playerId) return player;
    if (player.aliases.includes(rawInputName)) return player;
    return { ...player, aliases: [...player.aliases, rawInputName] };
  });
}

export function createNewPlayer(players: Player[], newId: string, rawInputName: string): Player[] {
  return [...players, { id: newId, name: rawInputName, aliases: [] }];
}
