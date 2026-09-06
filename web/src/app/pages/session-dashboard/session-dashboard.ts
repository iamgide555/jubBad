import { Component, OnDestroy, computed, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import { buildWaitingList } from '../../core/waiting-time';
import { CourtPanel } from './court-panel/court-panel';
import { StatsTable } from './stats-table/stats-table';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel, StatsTable],
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

  readonly waiting = computed(() => {
    const session = this.session();
    if (!session) return [];
    const ids = this.liveSession.waitingPlayerIds();
    return buildWaitingList(
      ids,
      resolvePlayerNames(ids, this.players()),
      session.lastPlayedAt,
      session.createdAt,
      this.now()
    );
  });

  readonly ended = computed(() => this.session()?.endedAt != null);
  readonly mode = computed(() => this.session()?.mode ?? 'variety');
  readonly anyCourtIdle = computed(() =>
    this.liveSession.courts().some((c) => c.status === 'idle')
  );
  readonly copied = signal(false);
  readonly endSessionError = signal<string | null>(null);

  constructor(
    protected liveSession: LiveSessionService,
    private router: Router
  ) {}

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

  async setMode(mode: 'variety' | 'balanced'): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.setMode(mode);
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

  async copyShareText(): Promise<void> {
    const text = this.shareText();
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard access can be denied or unavailable (older browsers, an
      // insecure origin). Surfacing the text is more useful than a dead button.
      this.rosterError.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
    }
  }

  ngOnDestroy(): void {
    clearInterval(this.clock);
  }

  async endSession(): Promise<void> {
    this.endSessionError.set(null);
    const result = await this.liveSession.endSession();
    if (!result.ok) {
      this.endSessionError.set(result.error ?? $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
      return;
    }
    this.router.navigateByUrl('/');
  }
}
