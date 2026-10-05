import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { PressDirective } from '../../../core/motion/press.directive';
import { Icon } from '../../../shared/icon/icon';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import type { Seat } from '../../../core/live-session.model';
import type { Player } from '../../../../../../engines/fuzzy-match.ts';

/** Which seat the host is filling: a saved lineup, or the not-yet-saved draft. */
interface Target {
  entryId: string | 'draft';
  team: 'A' | 'B';
  index: number;
}

interface Teams {
  teamA: Seat[];
  teamB: Seat[];
}

const EMPTY_DRAFT = (): Teams => ({ teamA: [null, null], teamB: [null, null] });

/**
 * Lineups the host sets before a court is free. When a court goes idle the
 * server seats the first lineup that fits and the engine completes any open
 * seats, so a partial lineup ("these two together") is as valid as a full one.
 *
 * Picking happens inside this panel: tap an open seat and the waiting players
 * appear right underneath, so nothing needs a scroll to the page's waiting list.
 */
@Component({
  selector: 'app-lineup-queue',
  imports: [PressDirective, NgTemplateOutlet, Icon],
  templateUrl: './lineup-queue.html',
  styleUrl: './lineup-queue.css',
})
export class LineupQueue {
  readonly players = input<Player[]>([]);
  /** Players waiting for a court, longest-waiting first. */
  readonly waiting = input<{ id: string; name: string }[]>([]);

  protected readonly draft = signal<Teams | null>(null);
  protected readonly picking = signal<Target | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor(protected liveSession: LiveSessionService) {}

  private readonly names = computed(() => {
    const ids = [
      ...this.liveSession.lineupQueue().flatMap((e) => [...e.teamA, ...e.teamB]),
      ...(this.draft() ? [...this.draft()!.teamA, ...this.draft()!.teamB] : []),
    ].filter((id): id is string => id !== null);
    return new Map(ids.map((id, i) => [id, resolvePlayerNames([id], this.players())[0] ?? ids[i]]));
  });

  protected readonly emptySeatLabel = $localize`:@@lineup.emptySeatLabel:เลือกผู้เล่นให้ช่องนี้`;

  protected removeSeatLabel(name: string): string {
    return $localize`:@@lineup.removeSeatLabel:เอา ${name}:name: ออกจากคิว`;
  }

  protected nameOf(id: Seat): string | null {
    return id === null ? null : (this.names().get(id) ?? id);
  }

  /**
   * Everyone who can still be lined up: waiting players first, in queue order,
   * then those still on a court (their lineup simply waits until they finish).
   * Resting players are left out, and nobody already in a lineup appears twice.
   */
  protected readonly pickable = computed(() => {
    const queued = this.liveSession.queuedPlayerIds();
    const inDraft = new Set(
      this.draft() ? [...this.draft()!.teamA, ...this.draft()!.teamB].filter((id) => id !== null) : []
    );
    const taken = (id: string) => queued.has(id) || inDraft.has(id);
    const waiting = this.waiting()
      .filter((w) => !taken(w.id))
      .map((w) => ({ id: w.id, name: w.name, playing: false }));
    const resting = new Set(this.liveSession.restingPlayerIds());
    const seen = new Set(waiting.map((w) => w.id));
    const playingIds: string[] = [];
    for (const court of this.liveSession.courts()) {
      if (court.status === 'idle') continue;
      for (const id of [...court.teamA, ...court.teamB]) {
        if (id !== null && !seen.has(id) && !resting.has(id) && !taken(id)) {
          seen.add(id);
          playingIds.push(id);
        }
      }
    }
    const names = resolvePlayerNames(playingIds, this.players());
    return [...waiting, ...playingIds.map((id, i) => ({ id, name: names[i], playing: true }))];
  });

  protected blockedReason(entryId: string, playerId: Seat): 'resting' | 'on-court' | null {
    if (playerId === null) return null;
    const entry = this.liveSession.lineupQueue().find((e) => e.id === entryId);
    return entry?.blocked.find((b) => b.playerId === playerId)?.reason ?? null;
  }

  protected isPicking(entryId: string, team: 'A' | 'B', index: number): boolean {
    const p = this.picking();
    return p !== null && p.entryId === entryId && p.team === team && p.index === index;
  }

  protected toggleDraft(): void {
    this.error.set(null);
    this.picking.set(null);
    this.draft.update((d) => (d ? null : EMPTY_DRAFT()));
  }

  protected tapSeat(entryId: string | 'draft', team: 'A' | 'B', index: number): void {
    this.error.set(null);
    const teams = this.teamsOf(entryId);
    if (!teams) return;
    const occupied = (team === 'A' ? teams.teamA : teams.teamB)[index] !== null;
    if (occupied) {
      this.picking.set(null);
      void this.setSeat(entryId, team, index, null);
      return;
    }
    this.picking.update((p) => (p && this.isPicking(entryId, team, index) ? null : { entryId, team, index }));
  }

  protected choose(playerId: string): void {
    const target = this.picking();
    if (!target) return;
    this.picking.set(null);
    void this.setSeat(target.entryId, target.team, target.index, playerId);
  }

  protected async move(id: string, direction: 'up' | 'down'): Promise<void> {
    this.error.set(null);
    const result = await this.liveSession.moveLineup(id, direction);
    this.error.set(result.ok ? null : (result.error ?? null));
  }

  protected async remove(id: string): Promise<void> {
    this.error.set(null);
    this.picking.set(null);
    const result = await this.liveSession.removeLineup(id);
    this.error.set(result.ok ? null : (result.error ?? null));
  }

  private teamsOf(entryId: string | 'draft'): Teams | null {
    if (entryId === 'draft') return this.draft();
    const entry = this.liveSession.lineupQueue().find((e) => e.id === entryId);
    return entry ? { teamA: entry.teamA, teamB: entry.teamB } : null;
  }

  private async setSeat(entryId: string | 'draft', team: 'A' | 'B', index: number, playerId: string | null) {
    const current = this.teamsOf(entryId);
    if (!current) return;
    const next: Teams = { teamA: [...current.teamA], teamB: [...current.teamB] };
    (team === 'A' ? next.teamA : next.teamB)[index] = playerId;

    if (entryId === 'draft') {
      // Nothing is saved until the draft holds someone.
      const anyone = [...next.teamA, ...next.teamB].some((id) => id !== null);
      if (!anyone) {
        this.draft.set(next);
        return;
      }
      this.busy.set(true);
      const result = await this.liveSession.addLineup(next.teamA, next.teamB);
      this.busy.set(false);
      if (result.ok) this.draft.set(null);
      else this.error.set(result.error ?? null);
      return;
    }

    const empty = [...next.teamA, ...next.teamB].every((id) => id === null);
    this.busy.set(true);
    const result = empty
      ? await this.liveSession.removeLineup(entryId)
      : await this.liveSession.replaceLineup(entryId, next.teamA, next.teamB);
    this.busy.set(false);
    this.error.set(result.ok ? null : (result.error ?? null));
  }
}
