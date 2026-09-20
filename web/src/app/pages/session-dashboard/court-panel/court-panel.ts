import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PressDirective } from '../../../core/motion/press.directive';
import { ClockService } from '../../../core/clock.service';
import { elapsedSeconds, formatClock } from '../../../core/game-duration';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import { SwapSelectionService, type SwapPick } from '../../../core/swap-selection.service';
import type { CourtFormat, CourtState, Seat } from '../../../core/live-session.model';
import type { Player } from '../../../../../../engines/fuzzy-match.ts';
import { Icon } from '../../../shared/icon/icon';

/** Past this many elapsed minutes, the timer flags the court as likely
 *  overrun — almost always a score that was never submitted. */
const OVERRUN_MINUTES = 30;

/** One seat on a pending court: occupied (a player) or empty (custom mode
 *  only). `team`/`index` are what the seats endpoint addresses. */
interface SeatView {
  team: 'A' | 'B';
  index: number;
  playerId: string | null;
  name: string | null;
}

@Component({
  selector: 'app-court-panel',
  imports: [FormsModule, PressDirective, Icon],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();
  readonly players = input<Player[]>([]);
  /** playerId -> real games played this session (from the stats endpoint, not
   *  the rotation-fairness `queueGames` number) — absent means 0, never a
   *  dash, since a court is exactly where "how many games has this person
   *  had" needs to read at a glance. */
  readonly gamesPlayed = input<Record<string, number>>({});

  readonly scoreA = signal<number | null>(null);
  readonly scoreB = signal<number | null>(null);
  readonly notEnoughPlayers = signal(false);
  /**
   * Set only when a doubles court came back short with 2 or 3 players free —
   * exactly the case a switch to singles would fix, and exactly the moment
   * the host wants to be told about it. Null otherwise, including when the
   * court has 0-1 free (switching would not help) or is already singles.
   */
  readonly trySinglesAvailable = signal<number | null>(null);
  readonly noSubstitute = signal(false);
  readonly busy = signal(false);
  /** A rejected request — mostly the pairing-lifecycle 409s. */
  readonly actionError = signal<string | null>(null);

  protected readonly selection = inject(SwapSelectionService);
  private readonly clock = inject(ClockService);

  constructor(protected liveSession: LiveSessionService) {}

  /**
   * The pending pairing's id, or null when there is nothing to swap. The
   * highlight states read this rather than re-narrowing the court union in
   * the template at every use.
   */
  protected readonly pendingPairingId = computed<string | null>(() => {
    const c = this.court();
    return c.status === 'pending' ? c.pairingId : null;
  });

  protected pickFor(playerId: string): SwapPick {
    return {
      playerId,
      name: resolvePlayerNames([playerId], this.players())[0],
      pairingId: this.pendingPairingId(),
    };
  }

  /** True for a slot that would receive whoever is currently held. */
  protected isTarget(playerId: string): boolean {
    const held = this.selection.selection();
    return held !== null && held.playerId !== playerId && this.pendingPairingId() !== null;
  }

  protected readonly court = computed<CourtState>(
    () => this.liveSession.courts()[this.courtNumber() - 1] ?? { status: 'idle', format: 'doubles' }
  );

  protected readonly isCustom = computed(() => this.liveSession.mode() === 'custom');

  private seatViewsFor(team: 'A' | 'B'): SeatView[] {
    const c = this.court();
    if (c.status !== 'pending') return [];
    const seats: Seat[] = team === 'A' ? c.teamA : c.teamB;
    return seats.map((playerId, index) => ({
      team,
      index,
      playerId,
      name: playerId === null ? null : resolvePlayerNames([playerId], this.players())[0],
    }));
  }

  protected readonly seatsA = computed<SeatView[]>(() => this.seatViewsFor('A'));
  protected readonly seatsB = computed<SeatView[]>(() => this.seatViewsFor('B'));

  protected readonly emptySeatCount = computed(
    () => [...this.seatsA(), ...this.seatsB()].filter((s) => s.playerId === null).length
  );

  private seatFor(playerId: string): SeatView | undefined {
    return [...this.seatsA(), ...this.seatsB()].find((s) => s.playerId === playerId);
  }

  /** aria-label for an empty seat's button: what tapping it does right now. */
  protected emptySeatLabel(): string {
    const held = this.selection.selection();
    return held === null
      ? $localize`:@@court.emptySeat:ที่ว่าง`
      : $localize`:@@court.dropIntoSeat:วาง ${held.name}:name: ลงที่ว่าง`;
  }

  /**
   * The toggle only ever writes while idle — a live pairing's team size must
   * never disagree with its court's configured format, and idle is the only
   * state where nothing in progress depends on it. The server enforces this
   * regardless (a stale tab could still hold an idle read), so this is a
   * courtesy, not the real guard.
   */
  protected readonly formatToggleDisabled = computed(() => this.court().status !== 'idle' || this.ended());

  /** Two 2-glyph segments (คู่/เดี่ยว) carry no meaning alone without this group label. */
  protected readonly formatGroupLabel = $localize`:@@court.formatLabel:รูปแบบการเล่น`;

  protected readonly ended = computed(() => {
    if (this.liveSession.sessionResource.error()) return false;
    return this.liveSession.sessionResource.value()?.endedAt != null;
  });

  /** Seconds this court's current match has been running, or null when it
   *  is not active (no timer to show on an idle or pending court).
   *
   *  `serverSkewMs` is deviceNow - serverNow at the moment the last response
   *  landed, so it is *subtracted* from the ticking device clock to get back
   *  to the server's timeline that `startedAt` was written in. */
  protected readonly liveElapsedSeconds = computed<number | null>(() => {
    const c = this.court();
    if (c.status !== 'active') return null;
    return elapsedSeconds(c.startedAt, this.clock.now() - this.liveSession.serverSkewMs());
  });

  protected readonly timerLabel = computed<string | null>(() => {
    const seconds = this.liveElapsedSeconds();
    return seconds === null ? null : formatClock(seconds);
  });

  /** True once the current match has run past OVERRUN_MINUTES — almost
   *  always a score nobody submitted, blocking the court from freeing up. */
  protected readonly overrun = computed(() => {
    const seconds = this.liveElapsedSeconds();
    return seconds !== null && seconds >= OVERRUN_MINUTES * 60;
  });

  /** Accessible name for the timer — whole minutes, not ticking seconds;
   *  announcing a value that changes every second would be hostile. */
  protected timerAriaLabel(): string {
    const seconds = this.liveElapsedSeconds() ?? 0;
    return $localize`:@@court.elapsedMinutes:เล่นมาแล้ว ${Math.floor(seconds / 60)}:minutes: นาที`;
  }

  protected teamNames(ids: string[]): string[] {
    return resolvePlayerNames(ids, this.players());
  }

  protected gamesFor(playerId: string): number {
    return this.gamesPlayed()[playerId] ?? 0;
  }

  /**
   * A player rested after this proposal was made is still standing in it — the
   * server refuses the confirm, and without this the host only finds out by
   * tapping. Named on screen so the fix (swap that name, or reshuffle) is
   * obvious. Active matches are untouched: those players are on court.
   */
  protected readonly restingInProposal = computed<string[]>(() => {
    const c = this.court();
    if (c.status !== 'pending') return [];
    const resting = new Set(this.liveSession.sessionResource.value()?.restingPlayerIds ?? []);
    const inProposal = [...c.teamA, ...c.teamB].filter(
      (id): id is string => id !== null && resting.has(id)
    );
    return resolvePlayerNames(inProposal, this.players());
  });

  /**
   * In TS rather than an `i18n-aria-label` attribute: the label interpolates a
   * player name, so it has to be a binding, and Angular only extracts static
   * attributes.
   *
   * The label has to say what *this* tap will do, because one control now has
   * three meanings depending on what is held. A screen reader announcing
   * "เปลี่ยน X ออก" on every name would be wrong two times out of three.
   */
  protected swapLabel(playerId: string, name: string): string {
    const held = this.selection.selection();
    if (held === null) {
      return $localize`:@@court.selectPlayer:เลือก ${name}:name: เพื่อสลับตัว`;
    }
    if (held.playerId === playerId) {
      return this.isCustom()
        ? $localize`:@@court.vacateSeat:เอา ${name}:name: ออกจากที่นั่ง`
        : $localize`:@@court.swapOut:เปลี่ยน ${name}:name: ออก`;
    }
    return $localize`:@@court.swapWith:สลับ ${held.name}:held: กับ ${name}:name:`;
  }

  /**
   * The winner buttons say only "ชนะ" — their column is what identifies the
   * team — so the name has to reach a screen reader some other way. `& `-
   * joined for doubles; for a singles team this is just the one name, not
   * "X & undefined".
   */
  protected wonLabel(names: string[]): string {
    const team = names.join(' & ');
    return $localize`:@@court.wonBy:${team}:team: ชนะ`;
  }

  /** In TS for the same reason as swapLabel: a dynamic count inside the sentence. */
  protected trySinglesHint(available: number): string {
    return $localize`:@@court.trySingles:เหลือ ${available}:count: คน — สลับเป็นเดี่ยวได้`;
  }

  protected async startOrReshuffle(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.proposeMatch(this.courtNumber());
      const short = !result.ok && result.reason === 'not-enough-players';
      this.notEnoughPlayers.set(short);
      const available = result.available;
      this.trySinglesAvailable.set(
        short && result.format === 'doubles' && available !== undefined && available >= 2 && available <= 3
          ? available
          : null
      );
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Idle-only (see `formatToggleDisabled`); the server is the real guard and
   * refuses with COURT_ACTIVE if a stale read let a disabled tap through.
   */
  protected async setFormat(format: CourtFormat): Promise<void> {
    if (this.busy() || this.formatToggleDisabled() || this.court().format === format) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.setCourtFormat(this.courtNumber(), format);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * One gesture for the whole screen: tap a name to hold it, tap a second
   * name to swap the two, or tap the held name again to take them off court
   * and let the server pick the replacement.
   *
   * Drag and drop used to sit on top of this and was removed — CDK lifted the
   * name out of the flow while a drop only registered on the slot wrapper, so
   * the gesture both looked broken and frequently missed. Clicking is the only
   * input now, which also makes it work identically on touch and keyboard.
   */
  protected async swap(pairingId: string, playerId: string): Promise<void> {
    const held = this.selection.selection();
    if (held === null) {
      this.selection.toggle(this.pickFor(playerId));
      return;
    }
    if (held.playerId === playerId) {
      this.selection.clear();
      // In custom mode, the second tap vacates the seat — the host opted out
      // of rotation choosing a replacement, so there is nothing for the
      // ordinary swap endpoint to pick. Every other mode keeps "take them
      // off, server chooses."
      const seat = this.isCustom() ? this.seatFor(playerId) : undefined;
      if (seat) {
        await this.runSetSeat(pairingId, seat.team, seat.index);
        return;
      }
      await this.runSwap(pairingId, playerId);
      return;
    }
    await this.applyManualSwap(pairingId, playerId, held);
  }

  /** Tapping an empty seat: places whoever is held, or does nothing if
   *  nobody is. The button stays enabled either way (see `emptySeatLabel`)
   *  so it is still reachable by keyboard and announced correctly. */
  protected async tapSeat(pairingId: string, seat: SeatView): Promise<void> {
    if (seat.playerId !== null) {
      await this.swap(pairingId, seat.playerId);
      return;
    }
    const held = this.selection.selection();
    if (held === null) return;
    this.selection.clear();
    await this.runSetSeat(pairingId, seat.team, seat.index, held.playerId);
  }

  private async runSetSeat(
    pairingId: string,
    team: 'A' | 'B',
    index: number,
    playerId?: string
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.setSeat(pairingId, team, index, playerId);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /** Fills every remaining empty seat on this court from the normal
   *  rotation pool, leaving already-seated players exactly where they are. */
  protected async autoPair(pairingId: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.autoPair(pairingId);
      const short = !result.ok && result.reason === 'not-enough-players';
      this.notEnoughPlayers.set(short);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Puts a player down onto the slot `playerId` occupies. The request always
   * names the court being tapped; when the held player came from another
   * court the server trades the two, so the far court does not need a second
   * call that could half-apply.
   */
  private async applyManualSwap(
    pairingId: string,
    playerId: string,
    held: SwapPick
  ): Promise<void> {
    this.selection.clear();
    await this.runSwap(pairingId, playerId, held.playerId);
  }

  private async runSwap(
    pairingId: string,
    playerId: string,
    withPlayerId?: string
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.swapPlayer(pairingId, playerId, withPlayerId);
      this.noSubstitute.set(!result.ok && result.reason === 'no-substitute');
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Reverses this court's last step — a mis-tapped winner, or a confirm the
   * host did not mean. Offered on every state because the mistake is only
   * noticed after the court has already moved on.
   */
  protected async undo(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.undoCourt(this.courtNumber());
      if (!result.ok && result.reason === 'players-busy') {
        this.actionError.set(
          $localize`:@@court.undoBusy:ผู้เล่นลงคอร์ทอื่นแล้ว ย้อนกลับไม่ได้`
        );
        return;
      }
      if (!result.ok && result.reason === 'nothing-to-undo') {
        this.actionError.set($localize`:@@court.nothingToUndo:ไม่มีอะไรให้ย้อนกลับ`);
        return;
      }
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirm(): Promise<void> {
    const c = this.court();
    if (c.status !== 'pending' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.confirmMatch(c.pairingId);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /** `winner: null` frees the court for a match abandoned without a result. */
  protected async finish(winner: 'A' | 'B' | null): Promise<void> {
    const c = this.court();
    if (c.status !== 'active' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const scores = winner === null ? [null, null] : [this.scoreA(), this.scoreB()];
      const result = await this.liveSession.finishMatch(c.pairingId, scores[0], scores[1], winner);
      this.actionError.set(result.error ?? null);
      if (!result.ok) return;
      this.scoreA.set(null);
      this.scoreB.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}
