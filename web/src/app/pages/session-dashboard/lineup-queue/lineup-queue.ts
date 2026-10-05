import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, OnDestroy, computed, effect, input, signal, viewChild } from '@angular/core';
import { PressDirective } from '../../../core/motion/press.directive';
import { Icon } from '../../../shared/icon/icon';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import type { Seat } from '../../../core/live-session.model';
import type { Player } from '../../../../../../engines/fuzzy-match.ts';

/** A lineup being built or edited. `entryId` is null for a new one. Nothing reaches the server until Save. */
interface Draft {
  entryId: string | null;
  teamA: Seat[];
  teamB: Seat[];
}

/** Which seat of the draft the host is choosing a player for. */
interface Picking {
  team: 'A' | 'B';
  index: number;
}

const EMPTY_TEAM = (): Seat[] => [null, null];

/**
 * The pre-set lineup dialog. Lineups the host sets before a court is free: when
 * a court goes idle the server seats the first lineup that fits and the engine
 * completes any open seats, so a partial lineup ("these two together") is as
 * valid as a full one.
 *
 * A lineup is built as a local draft and only Save sends it. Saving on the first
 * pick would let a freeing court take a half-built lineup, and would reserve the
 * player before the host had decided. The draft lives in this component, so
 * closing the dialog (backdrop click, Esc) keeps it until Save, Cancel or Clear.
 */
@Component({
  selector: 'app-lineup-queue',
  imports: [PressDirective, NgTemplateOutlet, Icon],
  templateUrl: './lineup-queue.html',
  styleUrl: './lineup-queue.css',
})
export class LineupQueue implements OnDestroy {
  readonly players = input<Player[]>([]);
  /** Players waiting for a court, longest-waiting first. */
  readonly waiting = input<{ id: string; name: string }[]>([]);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly draft = signal<Draft | null>(null);
  protected readonly picking = signal<Picking | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor(protected liveSession: LiveSessionService) {
    // A lineup a court has just taken (or another device removed) cannot be edited any more.
    effect(() => {
      const d = this.draft();
      if (d?.entryId && !this.liveSession.lineupQueue().some((e) => e.id === d.entryId)) {
        this.draft.set(null);
        this.picking.set(null);
      }
    });
  }

  /** Clear-all asks twice: the first tap arms it for a few seconds, the second one deletes. */
  protected readonly clearArmed = signal(false);
  private clearTimer?: ReturnType<typeof setTimeout>;

  ngOnDestroy(): void {
    clearTimeout(this.clearTimer);
  }

  /** Reordering means nothing with a single lineup. */
  protected readonly canReorder = computed(() => this.liveSession.lineupQueue().length > 1);

  /** What a lineup is waiting on, in words, instead of a red alarm on a normal state. */
  protected statusLine(entryId: string): string | null {
    const entry = this.liveSession.lineupQueue().find((e) => e.id === entryId);
    if (!entry || entry.blocked.length === 0) return null;
    const names = (reason: 'resting' | 'on-court') =>
      entry.blocked
        .filter((b) => b.reason === reason)
        .map((b) => this.nameOf(b.playerId))
        .join(', ');
    const lines: string[] = [];
    const playing = names('on-court');
    if (playing) lines.push($localize`:@@lineup.waitingOn:รอ ${playing}:names: เล่นจบก่อน`);
    const resting = names('resting');
    if (resting) lines.push($localize`:@@lineup.restingSwap:${resting}:names: พักอยู่ ระบบจะหาคนแทน`);
    return lines.join(' · ');
  }

  open(): void {
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected readonly newHeading = $localize`:@@lineup.newMatch:แมตช์ใหม่`;

  protected editHeading(n: number): string {
    return $localize`:@@lineup.editMatch:แก้คิวที่ ${n}:n:`;
  }

  protected readonly emptySeatLabel = $localize`:@@lineup.emptySeatLabel:เลือกผู้เล่นให้ช่องนี้`;

  protected removeSeatLabel(name: string): string {
    return $localize`:@@lineup.removeSeatLabel:เอา ${name}:name: ออกจากคิว`;
  }

  private readonly names = computed(() => {
    const d = this.draft();
    const ids = [
      ...this.liveSession.lineupQueue().flatMap((e) => [...e.teamA, ...e.teamB]),
      ...(d ? [...d.teamA, ...d.teamB] : []),
    ].filter((id): id is string => id !== null);
    const resolved = resolvePlayerNames(ids, this.players());
    return new Map(ids.map((id, i) => [id, resolved[i]]));
  });

  protected nameOf(id: Seat): string | null {
    return id === null ? null : (this.names().get(id) ?? id);
  }

  /** The saved lineup being edited sits in the list as its draft editor instead. */
  protected isEditing(entryId: string): boolean {
    return this.draft()?.entryId === entryId;
  }

  protected readonly canSave = computed(() => {
    const d = this.draft();
    return d !== null && [...d.teamA, ...d.teamB].some((id) => id !== null) && !this.busy();
  });

  /**
   * Everyone who can still be lined up: waiting players first, in queue order,
   * then those still on a court (their lineup simply waits until they finish).
   * Resting players are left out, as is anyone already in another lineup or in
   * this draft. A lineup being edited keeps its own players selectable.
   */
  protected readonly pickable = computed(() => {
    const d = this.draft();
    const taken = new Set<string>(
      this.liveSession
        .lineupQueue()
        .filter((e) => e.id !== d?.entryId)
        .flatMap((e) => [...e.teamA, ...e.teamB])
        .filter((id): id is string => id !== null)
    );
    for (const id of d ? [...d.teamA, ...d.teamB] : []) if (id !== null) taken.add(id);

    const waiting = this.waiting()
      .filter((w) => !taken.has(w.id))
      .map((w) => ({ id: w.id, name: w.name, playing: false }));
    const resting = new Set(this.liveSession.restingPlayerIds());
    const seen = new Set(waiting.map((w) => w.id));
    const playingIds: string[] = [];
    for (const court of this.liveSession.courts()) {
      if (court.status === 'idle') continue;
      for (const id of [...court.teamA, ...court.teamB]) {
        if (id !== null && !seen.has(id) && !resting.has(id) && !taken.has(id)) {
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

  protected isPicking(team: 'A' | 'B', index: number): boolean {
    const p = this.picking();
    return p !== null && p.team === team && p.index === index;
  }

  protected startNew(): void {
    this.error.set(null);
    this.picking.set(null);
    this.draft.set({ entryId: null, teamA: EMPTY_TEAM(), teamB: EMPTY_TEAM() });
  }

  /** Tapping a seat of a saved lineup opens a copy of it for editing. */
  protected edit(entryId: string): void {
    const entry = this.liveSession.lineupQueue().find((e) => e.id === entryId);
    if (!entry) return;
    this.error.set(null);
    this.picking.set(null);
    this.draft.set({ entryId, teamA: [...entry.teamA], teamB: [...entry.teamB] });
  }

  protected cancelDraft(): void {
    this.error.set(null);
    this.picking.set(null);
    this.draft.set(null);
  }

  protected tapSeat(team: 'A' | 'B', index: number): void {
    const d = this.draft();
    if (!d) return;
    this.error.set(null);
    const seats = team === 'A' ? d.teamA : d.teamB;
    if (seats[index] !== null) {
      this.picking.set(null);
      this.setSeat(team, index, null);
      return;
    }
    this.picking.update((p) => (p && p.team === team && p.index === index ? null : { team, index }));
  }

  protected choose(playerId: string): void {
    const target = this.picking();
    if (!target) return;
    this.picking.set(null);
    this.setSeat(target.team, target.index, playerId);
  }

  private setSeat(team: 'A' | 'B', index: number, playerId: string | null): void {
    this.draft.update((d) => {
      if (!d) return d;
      const next = { ...d, teamA: [...d.teamA], teamB: [...d.teamB] };
      (team === 'A' ? next.teamA : next.teamB)[index] = playerId;
      return next;
    });
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d || !this.canSave()) return;
    this.busy.set(true);
    const result = d.entryId
      ? await this.liveSession.replaceLineup(d.entryId, d.teamA, d.teamB)
      : await this.liveSession.addLineup(d.teamA, d.teamB);
    this.busy.set(false);
    if (result.ok) {
      this.error.set(null);
      this.picking.set(null);
      this.draft.set(null);
    } else {
      // The draft stays, so the host can fix the seat the server objected to.
      this.error.set(result.error ?? null);
    }
  }

  protected async move(id: string, direction: 'up' | 'down'): Promise<void> {
    this.error.set(null);
    const result = await this.liveSession.moveLineup(id, direction);
    this.error.set(result.ok ? null : (result.error ?? null));
  }

  protected async remove(id: string): Promise<void> {
    this.error.set(null);
    if (this.draft()?.entryId === id) this.cancelDraft();
    const result = await this.liveSession.removeLineup(id);
    this.error.set(result.ok ? null : (result.error ?? null));
  }

  protected async clearAll(): Promise<void> {
    if (!this.clearArmed()) {
      this.clearArmed.set(true);
      clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => this.clearArmed.set(false), 4000);
      return;
    }
    clearTimeout(this.clearTimer);
    this.clearArmed.set(false);
    this.error.set(null);
    this.cancelDraft();
    const result = await this.liveSession.clearLineups();
    this.error.set(result.ok ? null : (result.error ?? null));
  }
}
