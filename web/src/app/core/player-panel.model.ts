import type { Level } from '../../../../engines/levels.ts';

/** One row of the dashboard's toggle player panel (C1a) — see
 *  SessionsService.getPlayerPanel's doc comment for what each field means. */
export interface PlayerPanelRow {
  playerId: string;
  name: string;
  level: Level | null;
  resting: boolean;
  played: number;
  won: number;
  lost: number;
  ratingDelta: number | null;
}
