import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';
import { resolvePlayerNames } from '../../core/player-names';
import { buildWaitingList } from '../../core/waiting-time';
import { SwapSelectionService, type SwapPick } from '../../core/swap-selection.service';
import { CourtPanel } from './court-panel/court-panel';
import type { Player } from '../../../../../engines/fuzzy-match.ts';
import type { PlayerStat } from '../../core/stats.model';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel, RouterLink],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard implements OnDestroy {
  protected readonly session = computed(() => {
    if (this.liveSession.sessionResource.error()) return undefined;
    return this.liveSession.sessionResource.value();
  });

  protected readonly sessionExists = computed(() => this.session() !== undefined);

  private readonly playersResource = httpResource<Player[]>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}/players` : undefined;
  });

  protected readonly players = computed<Player[]>(() => {
    if (this.playersResource.error()) return [];
    return this.playersResource.value() ?? [];
  });

  /**
   * Real games-played per player, for the court card tally — deliberately a
   * separate fetch from `session().queueGames`, which is a rotation-fairness
   * number that can include an offset credit and is documented as "not a
   * statistic." Every mutation (`LiveSessionService`'s shared `post()`
   * helper) reloads `sessionResource` before returning, so reading `session()`
   * here — the same dependency `players` above already relies on — is
   * enough to refetch after every confirm/finish/undo without a second,
   * independently-timed trigger racing it (that raced `mutationVersion` bump
   * against the session reload it always accompanies, and lost).
   */
  private readonly statsResource = httpResource<PlayerStat[]>(() => {
    const code = this.session()?.code;
    return code ? `${environment.apiBaseUrl}/sessions/${code}/stats?scope=session` : undefined;
  });

  protected readonly gamesPlayed = computed<Record<string, number>>(() => {
    if (this.statsResource.error()) return {};
    const record: Record<string, number> = {};
    for (const row of this.statsResource.value() ?? []) record[row.playerId] = row.played;
    return record;
  });

  /**
   * The roster chips double as the rest control, so each one needs its id and
   * whether it is resting — not just a display name.
   */
  readonly rosterEntries = computed(() => {
    const session = this.session();
    if (!session) return [];
    const resting = new Set(session.restingPlayerIds);
    const names = resolvePlayerNames(session.rosterPlayerIds, this.players());
    return session.rosterPlayerIds.map((id, i) => ({
      id,
      name: names[i],
      resting: resting.has(id),
    }));
  });

  readonly waitlistNames = computed(() => {
    const session = this.session();
    if (!session) return [];
    return resolvePlayerNames(session.waitlistPlayerIds, this.players());
  });

  readonly courtNumbers = computed(() => this.liveSession.courts().map((_, i) => i + 1));

  /**
   * Ticks so the displayed wait times advance on their own. Minute resolution,
   * so a 30s tick is enough to never look more than half a minute stale.
   */
  private readonly now = signal(Date.now());
  private readonly clock = setInterval(() => this.now.set(Date.now()), 30_000);
  private readonly refreshInterval = setInterval(() => this.liveSession.refresh(), 30_000);
  private readonly onWindowFocus = () => this.liveSession.refresh();

  protected readonly selection = inject(SwapSelectionService);

  /**
   * A waiting player carries no pairing id — they are on nobody's court, so a
   * swap involving them is a plain substitution rather than a trade.
   */
  protected waitingPick(id: string, name: string): SwapPick {
    return { playerId: id, name, pairingId: null };
  }

  /**
   * The waiting-list half of the one swap gesture. Holding someone who is on a
   * court and then tapping a waiting player substitutes the two — that is the
   * main way anyone gets on court, so it has to work from this side as well as
   * from the court panel.
   *
   * Tapping a waiting player a second time only puts them back down. It never
   * triggers the "take them off, server picks a replacement" path that the same
   * gesture has on a court, because there is no court to take them off of.
   */
  protected async pickWaiting(id: string, name: string): Promise<void> {
    const held = this.selection.selection();
    if (held !== null && held.pairingId !== null && held.playerId !== id) {
      this.selection.clear();
      this.rosterError.set(null);
      const result = await this.liveSession.swapPlayer(held.pairingId, held.playerId, id);
      this.rosterError.set(result.error ?? null);
      return;
    }
    this.selection.toggle(this.waitingPick(id, name));
  }

  protected waitingPickLabel(name: string): string {
    const held = this.selection.selection();
    if (held !== null && held.pairingId !== null) {
      return $localize`:@@dashboard.swapWithWaiting:สลับ ${held.name}:held: กับ ${name}:name:`;
    }
    return $localize`:@@dashboard.pickWaiting:เลือก ${name}:name: ลงคอร์ท`;
  }

  readonly waiting = computed(() => {
    const session = this.session();
    if (!session) return [];
    const ids = this.liveSession.waitingPlayerIds();
    return buildWaitingList(
      ids,
      resolvePlayerNames(ids, this.players()),
      session.lastPlayedAt,
      session.createdAt,
      session.endedAt ? new Date(session.endedAt).getTime() : this.now(),
      session.activatedAt,
      session.queueGames
    );
  });

  readonly ended = computed(() => this.session()?.endedAt != null);
  readonly mode = computed(() => this.session()?.mode ?? 'variety');
  readonly courtCount = computed(() => this.courtNumbers().length);
  readonly anyCourtIdle = computed(() =>
    this.liveSession.courts().some((c) => c.status === 'idle')
  );
  readonly copied = signal(false);
  readonly endSessionError = signal<string | null>(null);
  readonly clipboardFallback = signal<string | null>(null);

  constructor(
    protected liveSession: LiveSessionService,
    private router: Router
  ) {
    window.addEventListener('focus', this.onWindowFocus);
  }

  readonly rosterError = signal<string | null>(null);

  /** In TS, not an i18n attribute: the label interpolates a player name. */
  restLabel(name: string, resting: boolean): string {
    return resting
      ? $localize`:@@dashboard.bringBack:ให้ ${name}:name: กลับมาเล่น`
      : $localize`:@@dashboard.rest:ให้ ${name}:name: พัก`;
  }

  /** `resting` is the state being asked for; the API takes its inverse. */
  async toggleResting(playerId: string, resting: boolean): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.setPlayerActive(playerId, !resting);
    this.rosterError.set(result.error ?? null);
  }

  async fillCourts(): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.fillCourts();
    if (!result.ok && result.reason === 'not-enough-players') {
      this.rosterError.set($localize`:@@dashboard.notEnoughToFill:ผู้เล่นไม่พอ`);
      return;
    }
    this.rosterError.set(result.error ?? null);
  }

  /**
   * Manual escape hatch for when two courts finish out of sync and the host
   * spots the same group about to land back on a court together: pushes
   * everyone waiting except the one with the fewest games behind the players
   * currently on court, so the next draw is forced to pick someone else.
   */
  async deprioritizeWaiting(): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.deprioritizeWaiting();
    this.rosterError.set(result.error ?? null);
  }

  async setMode(mode: 'variety' | 'balanced'): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.setMode(mode);
    this.rosterError.set(result.error ?? null);
  }

  /**
   * Court bookings change mid-evening (one court at 19:00, three at 20:00 is a
   * normal booking), so the host adjusts the count when the later slot starts.
   * Stepping rather than free text: the value is small and the host is on a
   * phone at courtside.
   */
  async changeCourtCount(delta: number): Promise<void> {
    const next = this.courtCount() + delta;
    if (next < 1 || next > 20) return;
    this.rosterError.set(null);
    const result = await this.liveSession.setCourtCount(next);
    this.rosterError.set(result.error ?? null);
  }

  /**
   * Plain text for pasting back into LINE. Built from what is on screen rather
   * than a second server view, so the two can never disagree.
   */
  shareText(): string {
    const lines: string[] = [];
    // Court number is the array position — the server returns one entry per
    // court in order, which is the same assumption courtNumbers() makes.
    for (const [i, court] of this.liveSession.courts().entries()) {
      const number = i + 1;
      if (court.status !== 'active') {
        lines.push($localize`:@@share.courtIdle:คอร์ท ${number}:n:: ว่าง`);
        continue;
      }
      const [a1, a2] = resolvePlayerNames(court.teamA, this.players());
      const [b1, b2] = resolvePlayerNames(court.teamB, this.players());
      lines.push(`${$localize`:@@share.court:คอร์ท ${number}:n:`}: ${a1} + ${a2} vs ${b1} + ${b2}`);
    }
    const waiting = this.waiting().map((w) => w.name);
    if (waiting.length > 0) {
      lines.push(`${$localize`:@@share.waiting:รอคิว`}: ${waiting.join(', ')}`);
    }
    return lines.join('\n');
  }

  readonly displayLinkCopied = signal(false);

  /**
   * Nothing in the app has ever linked to the venue display — the host had to
   * know to type /display onto the end of the session URL. A read-only screen
   * meant for a wall is not much use if only the person who built it can find
   * it, so this hands over something pasteable.
   */
  async copyDisplayLink(): Promise<void> {
    const url = absoluteUrl(`/s/${this.session()!.code}/display`);
    this.clipboardFallback.set(null);
    const ok = await copyToClipboard(url);
    if (!ok) {
      this.rosterError.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
      this.clipboardFallback.set(url);
      return;
    }
    this.displayLinkCopied.set(true);
    setTimeout(() => this.displayLinkCopied.set(false), 2000);
  }

  readonly summaryLinkCopied = signal(false);

  async copySummaryLink(): Promise<void> {
    const url = absoluteUrl(`/s/${this.session()!.code}/summary`);
    this.clipboardFallback.set(null);
    const ok = await copyToClipboard(url);
    if (!ok) {
      this.rosterError.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
      this.clipboardFallback.set(url);
      return;
    }
    this.summaryLinkCopied.set(true);
    setTimeout(() => this.summaryLinkCopied.set(false), 2000);
  }

  async copyShareText(): Promise<void> {
    const text = this.shareText();
    this.clipboardFallback.set(null);
    if (await copyToClipboard(text)) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } else {
      this.rosterError.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
      this.clipboardFallback.set(text);
    }
  }

  ngOnDestroy(): void {
    clearInterval(this.clock);
    clearInterval(this.refreshInterval);
    window.removeEventListener('focus', this.onWindowFocus);
  }

  async endSession(): Promise<void> {
    this.endSessionError.set(null);
    const result = await this.liveSession.endSession();
    if (!result.ok) {
      this.endSessionError.set(result.error ?? $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
      return;
    }
    this.router.navigateByUrl(`/s/${this.session()!.code}/summary`);
  }
}
