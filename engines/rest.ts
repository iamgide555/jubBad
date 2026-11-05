/**
 * Who needs rest right now: the rest guard for the one-swap variety step in
 * engines/pairing.ts (`MatchHistory.needsRest`).
 *
 * A player needs rest when both hold:
 *
 * - They are fresh off court: their last game has ended and no game has
 *   started since. Playing next would be back-to-back.
 * - That last game was itself back-to-back: no other game started between
 *   their previous game ending and it starting.
 *
 * The swap step never pulls such a player forward past the queue, so it can
 * never make anyone's run of back-to-back games longer than the queue alone
 * would. "Started" means confirmed — a pending proposal is not a game yet.
 *
 * Measured in games started rather than minutes, so it means the same thing
 * on a quick doubles night and a long singles one. One deliberate blind spot:
 * when two courts are planned at once and confirmed seconds apart, the second
 * looks like it had a game start in between. That only ever leaves the guard
 * off, never wrongly on.
 */

export interface PlayedGame {
  players: readonly string[];
  /** Epoch milliseconds the game was confirmed (started). */
  confirmedAt: number;
  /** Epoch milliseconds it ended, or null while it is still on court. */
  endedAt: number | null;
}

export function playersNeedingRest(games: readonly PlayedGame[]): Set<string> {
  const starts = games.map((g) => g.confirmedAt).sort((a, b) => a - b);
  const startedBetween = (from: number, to: number) => starts.some((s) => s > from && s < to);
  const startedAfter = (from: number) => starts.some((s) => s > from);

  const byPlayer = new Map<string, PlayedGame[]>();
  for (const game of games) {
    for (const id of game.players) {
      const list = byPlayer.get(id) ?? [];
      list.push(game);
      byPlayer.set(id, list);
    }
  }

  const tired = new Set<string>();
  for (const [id, played] of byPlayer) {
    if (played.length < 2) continue;
    const ordered = [...played].sort((a, b) => a.confirmedAt - b.confirmedAt);
    const last = ordered[ordered.length - 1];
    const previous = ordered[ordered.length - 2];
    if (last.endedAt === null || previous.endedAt === null) continue;
    if (startedAfter(last.endedAt)) continue;
    if (startedBetween(previous.endedAt, last.confirmedAt)) continue;
    tired.add(id);
  }
  return tired;
}
