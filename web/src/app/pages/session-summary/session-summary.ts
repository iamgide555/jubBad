import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';
import { environment } from '../../../environments/environment';
import { SceneHost } from '../../core/three/scene-host';
import { formatMinutes } from '../../core/game-duration';
import { labelForCourt } from '../../core/court-label';
import { formatShuttlePriceInput } from '../../core/shuttle-money';
import {
  ShuttleDetailsDialog,
  type ShuttleDetailsPatch,
} from '../../shared/shuttle-details-dialog/shuttle-details-dialog';
import { ResultCorrectionDialog, type ResultCorrection } from '../../shared/result-correction-dialog/result-correction-dialog';
import { ShuttleCorrectionDialog } from '../../shared/shuttle-correction-dialog/shuttle-correction-dialog';
import type { PlayerSessionStat, SessionMatch, SessionSummary as Summary, ShuttleLogRow } from '../../core/session-summary.model';
import type { ShuttleInventory } from '../../core/shuttle.model';

type SortKey = 'played' | 'won' | 'lost' | 'doublesRate' | 'singlesRate' | 'time';

@Component({
  selector: 'app-session-summary',
  imports: [NgTemplateOutlet, RouterLink, SceneHost, ShuttleDetailsDialog, ShuttleCorrectionDialog, ResultCorrectionDialog],
  templateUrl: './session-summary.html',
  styleUrl: './session-summary.css',
})
export class SessionSummary {
  protected readonly sessionCode: string;

  private readonly summaryResource: ReturnType<typeof httpResource<Summary>>;

  protected readonly summary = computed<Summary | undefined>(() => {
    if (this.summaryResource.error()) return undefined;
    return this.summaryResource.value();
  });

  // The server already returns players sorted by played descending
  // (SessionsService.getSummary) — 'played' as the default keeps that
  // order until the host taps a different column header.
  protected readonly sortKey = signal<SortKey>('played');

  protected setSortKey(key: SortKey): void {
    this.sortKey.set(key);
  }

  private sortValue(row: PlayerSessionStat, key: SortKey): number | null {
    switch (key) {
      case 'played':
        return row.played;
      case 'won':
        return row.won;
      case 'lost':
        return row.lost;
      case 'doublesRate':
        return row.doubles ? this.winPercent(row.doubles.played, row.doubles.won) : null;
      case 'singlesRate':
        return row.singles ? this.winPercent(row.singles.played, row.singles.won) : null;
      case 'time':
        return row.totalSeconds;
    }
  }

  /** Descending by the active column; a player with no data for it (never
   *  played singles, say) sorts last rather than tying at a fabricated 0 —
   *  same convention as player-roster's sortable columns. */
  /** A match keeps its court number; the name shown is that court's latest
   *  label, including a court removed before the session ended. */
  protected courtName(courtNumber: number): string {
    return labelForCourt(this.summary()?.session.courtLabels ?? [], courtNumber);
  }

  protected readonly sortedPlayers = computed(() => {
    const players = this.summary()?.players ?? [];
    const key = this.sortKey();
    return [...players].sort((a, b) => {
      const av = this.sortValue(a, key);
      const bv = this.sortValue(b, key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  });

  protected readonly notFound = computed(
    () => this.summaryResource.error() !== undefined
  );

  /** Which player's match list is expanded, if any. */
  protected readonly expandedPlayerId = signal<string | null>(null);

  protected togglePlayer(playerId: string): void {
    this.expandedPlayerId.set(this.expandedPlayerId() === playerId ? null : playerId);
  }

  /** Whole percent — a casual group does not need decimal places. */
  protected winPercent(played: number, won: number): number | null {
    return played === 0 ? null : Math.round((won / played) * 100);
  }

  protected readonly formatMinutes = formatMinutes;

  /** Public, ordinary session data now — same visibility as date/venue/court
   *  count — per the approved decision this task's brief carries forward. */
  protected readonly formatShuttlePriceInput = formatShuttlePriceInput;

  /** Null when this player never played — same guard as winPercent. */
  protected averageMinutes(totalSeconds: number, played: number): string | null {
    return played === 0 ? null : formatMinutes(totalSeconds / played);
  }

  /**
   * This page is public, so anyone holding the link can open it. The back
   * link goes to the group's admin screen, which they cannot open — following
   * it would bounce them to a login page they have no token for and leave
   * them stranded. Also gates the profile column's copy-link button: a
   * player's profile is handed out by the host on request, not self-serve
   * from a summary link that might reach anyone.
   */
  protected readonly isHost = signal(false);

  // ---- owner-only shuttle editing ----
  //
  // `isHost` only says someone is logged in; it cannot tell the owner from
  // another group's host. Editing access is therefore proven by the owner-only
  // inventory read succeeding (a non-owner gets the same 404 the rest of the
  // app uses). On an ordinary session that read is empty and disabled — it
  // still proves ownership for the physical-count editor.
  protected readonly inventory = signal<ShuttleInventory | null>(null);
  protected readonly owner = computed(() => this.inventory() !== null);
  protected readonly canCorrect = computed(() => this.inventory()?.enabled === true);

  /** Owner-only revisions of finished games, which a result correction must send (works on ordinary sessions too). */
  private readonly resultRevisions = signal<ReadonlyMap<string, number>>(new Map());

  private async loadResultRevisions(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ games: { pairingId: string; revision: number }[] }>(
          `${environment.apiBaseUrl}/sessions/${this.sessionCode}/results`
        )
      );
      this.resultRevisions.set(new Map(res.games.map((g) => [g.pairingId, g.revision])));
    } catch {
      this.resultRevisions.set(new Map());
    }
  }

  private async loadInventory(): Promise<void> {
    void this.loadResultRevisions();
    try {
      this.inventory.set(
        await firstValueFrom(
          this.http.get<ShuttleInventory>(`${environment.apiBaseUrl}/sessions/${this.sessionCode}/shuttles`)
        )
      );
    } catch {
      this.inventory.set(null);
    }
  }

  /** The advanced session's log with its distinct subtotal and, when honest, the physical difference. */
  protected readonly shuttleSection = computed(() => {
    const s = this.summary();
    if (!s?.shuttleLog || !s.shuttleAccounting) return null;
    const a = s.shuttleAccounting;
    const physical = s.session.shuttleCount;
    const complete = a.unknownFinishedMatches === 0 && a.finishedMatches > 0;
    return {
      rows: s.shuttleLog,
      ...a,
      physical,
      difference: complete && physical !== null ? physical - a.recordedFinishedShuttles : null,
    };
  });

  protected signed(n: number): string {
    return n > 0 ? `+${n}` : `${n}`;
  }

  protected rowLabel(row: ShuttleLogRow): string {
    return $localize`:@@summary.shuttleRowLabel:คอร์ท ${this.courtName(row.courtNumber)}:court: · แมตช์ ${row.matchNumber}:match:`;
  }

  private readonly correctionDialog = viewChild<ShuttleCorrectionDialog>('correctionDialog');
  protected readonly correctingRow = signal<ShuttleLogRow | null>(null);
  protected readonly correctionSaving = signal(false);
  protected readonly correctionError = signal<string | null>(null);

  protected readonly correctionShuttles = computed(() =>
    (this.inventory()?.identities ?? []).filter((i) => !i.voided)
  );
  protected readonly correctionInitialIds = computed(() => {
    const row = this.correctingRow();
    if (!row) return [];
    return this.inventory()?.games.find((g) => g.pairingId === row.pairingId)?.shuttleIds ?? [];
  });

  protected openCorrection(row: ShuttleLogRow): void {
    this.correctingRow.set(row);
    this.correctionError.set(null);
    this.correctionDialog()?.open();
  }

  /**
   * Sends the correction with the revision this page last read. Whatever the
   * outcome the summary and inventory are re-read, so a stale write shows the
   * server's truth instead of an unsaved guess.
   */
  protected async saveCorrection(event: { shuttleIds: string[]; openNew: boolean }): Promise<void> {
    const row = this.correctingRow();
    const revision = this.inventory()?.games.find((g) => g.pairingId === row?.pairingId)?.revision;
    if (!row || revision === undefined || this.correctionSaving()) return;
    this.correctionSaving.set(true);
    this.correctionError.set(null);
    try {
      await firstValueFrom(
        this.http.post(
          `${environment.apiBaseUrl}/sessions/${this.sessionCode}/pairings/${row.pairingId}/shuttles/correct`,
          { ...event, expectedRevision: revision }
        )
      );
      this.correctionDialog()?.close();
    } catch (err) {
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      this.correctionError.set(
        code === 'PAIRING_STALE'
          ? $localize`:@@summary.correctionStale:ข้อมูลถูกแก้ไขจากอุปกรณ์อื่นแล้ว กรุณาลองใหม่อีกครั้ง`
          : code === 'SHUTTLE_NOT_FOUND'
            ? $localize`:@@summary.correctionNotFound:ไม่พบลูกแบดลูกนี้ อาจถูกลบไปแล้ว`
            : $localize`:@@summary.correctionFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`
      );
    } finally {
      this.correctionSaving.set(false);
      this.summaryResource.reload();
      void this.loadInventory();
    }
  }

  // ---- result correction (owner-only, any session) ----
  private readonly resultDialog = viewChild<ResultCorrectionDialog>('resultDialog');
  protected readonly correctingMatch = signal<SessionMatch | null>(null);
  protected readonly resultSaving = signal(false);
  protected readonly resultError = signal<string | null>(null);

  protected readonly canCorrectResult = computed(() => this.owner() && this.resultRevisions().size > 0);

  protected readonly correctingResult = computed<ResultCorrection>(() => {
    const m = this.correctingMatch();
    return { winner: m?.winner ?? null, scoreA: m?.scoreA ?? null, scoreB: m?.scoreB ?? null };
  });

  protected matchLabel(m: SessionMatch): string {
    return $localize`:@@summary.shuttleRowLabel:คอร์ท ${this.courtName(m.courtNumber)}:court: · แมตช์ ${m.matchNumber}:match:`;
  }

  protected openResultCorrection(m: SessionMatch): void {
    this.correctingMatch.set(m);
    this.resultError.set(null);
    this.resultDialog()?.open();
  }

  protected async saveResult(event: ResultCorrection): Promise<void> {
    const m = this.correctingMatch();
    const revision = m ? this.resultRevisions().get(m.pairingId) : undefined;
    if (!m || revision === undefined || this.resultSaving()) return;
    this.resultSaving.set(true);
    this.resultError.set(null);
    try {
      await firstValueFrom(
        this.http.post(
          `${environment.apiBaseUrl}/sessions/${this.sessionCode}/pairings/${m.pairingId}/result/correct`,
          { ...event, expectedRevision: revision }
        )
      );
      this.resultDialog()?.close();
    } catch (err) {
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      this.resultError.set(
        code === 'PAIRING_STALE'
          ? $localize`:@@summary.correctionStale:ข้อมูลถูกแก้ไขจากอุปกรณ์อื่นแล้ว กรุณาลองใหม่อีกครั้ง`
          : $localize`:@@summary.correctionFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`
      );
    } finally {
      this.resultSaving.set(false);
      this.summaryResource.reload();
      void this.loadInventory();
    }
  }

  // ---- shuttle count / price editor ----
  //
  // This page is otherwise entirely `httpResource` GETs with no
  // `LiveSessionService` — injecting it here just to reuse its
  // `setShuttleDetails` would fire an extra `GET /sessions/:code` for every
  // anonymous visitor (its constructor builds that resource eagerly) and
  // create a second, possibly-stale copy of the session data next to
  // `summary().session`. A direct `HttpClient` POST, reloading this page's
  // own `httpResource` on success, keeps this page's one-fetch identity
  // intact and costs about ten lines.
  private readonly http = inject(HttpClient);
  private readonly shuttleDialog = viewChild<ShuttleDetailsDialog>('shuttleDialog');
  protected readonly shuttleSaving = signal(false);
  protected readonly shuttleError = signal<string | null>(null);

  protected openShuttleEditor(): void {
    this.shuttleError.set(null);
    this.shuttleDialog()?.open();
  }

  protected async saveShuttleDetails(patch: ShuttleDetailsPatch): Promise<void> {
    if (this.shuttleSaving()) return;
    if (Object.keys(patch).length === 0) {
      this.shuttleDialog()?.close();
      return;
    }
    this.shuttleSaving.set(true);
    this.shuttleError.set(null);
    try {
      await firstValueFrom(
        this.http.post(`${environment.apiBaseUrl}/sessions/${this.sessionCode}/shuttle-details`, patch)
      );
      this.summaryResource.reload();
      this.shuttleDialog()?.close();
    } catch {
      this.shuttleError.set(
        $localize`:@@err.shuttleDetails:บันทึกข้อมูลลูกแบดไม่สำเร็จ`
      );
    } finally {
      this.shuttleSaving.set(false);
    }
  }

  /** The row whose profile link was just copied, so only that row confirms. */
  protected readonly sharedPlayerId = signal<string | null>(null);
  protected readonly shareFailed = signal(false);
  protected readonly clipboardFallback = signal<string | null>(null);

  protected async sharePlayer(playerId: string): Promise<void> {
    const groupCode = this.summary()?.session.groupCode;
    if (!groupCode) return;
    this.shareFailed.set(false);
    const url = absoluteUrl(`/g/${groupCode}/p/${playerId}`);
    this.clipboardFallback.set(null);
    const ok = await copyToClipboard(url);
    if (!ok) {
      this.shareFailed.set(true);
      this.clipboardFallback.set(url);
      return;
    }
    this.sharedPlayerId.set(playerId);
    setTimeout(() => {
      if (this.sharedPlayerId() === playerId) this.sharedPlayerId.set(null);
    }, 2000);
  }

  protected shareLabel(name: string): string {
    return $localize`:@@summary.sharePlayerLabel:คัดลอกลิงก์ของ ${name}:name:`;
  }

  constructor(route: ActivatedRoute) {
    const auth = inject(AuthService);
    void auth.check().then((authed) => {
      this.isHost.set(authed);
      // Ownership is proven by the inventory read, not by being logged in.
      if (authed) void this.loadInventory();
    });

    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.summaryResource = httpResource<Summary>(
      () => `${environment.apiBaseUrl}/sessions/${this.sessionCode}/summary`
    );
  }
}
