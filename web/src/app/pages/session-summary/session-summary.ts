import { durationSummary } from '../../core/session-duration-summary';
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
import { LineService } from '../../core/line.service';
import type { LineSummaryOutcome, LineSummaryState } from '../../core/line.model';
import type { PaymentCardPanel } from '../../core/payment-card.model';
import { PaymentCardService } from '../../core/payment-card.service';
import { PaymentSheet } from '../../shared/payment-sheet/payment-sheet';

type SortKey = 'played' | 'won' | 'lost' | 'doublesRate' | 'singlesRate' | 'time';

@Component({
  selector: 'app-session-summary',
  imports: [NgTemplateOutlet, RouterLink, SceneHost, ShuttleDetailsDialog, ShuttleCorrectionDialog, ResultCorrectionDialog, PaymentSheet],
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
      case 'time': {
        const time = durationSummary(row.matches);
        return row.matches.length > 0 && time.measuredMatchCount + time.estimatedMatchCount === 0 ? null : row.totalSeconds;
      }
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
  protected readonly durationSummary = durationSummary;

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

  // ---- owner-only LINE summary card ----
  private readonly lineService = inject(LineService);
  protected readonly lineState = signal<LineSummaryState | null>(null);
  /** What happened to the card: carried here from ending the session, or from the last button press. */
  protected readonly lineOutcome = signal<LineSummaryOutcome | null>(
    (history.state as { lineSummary?: LineSummaryOutcome } | null)?.lineSummary ?? null
  );
  protected readonly lineSending = signal(false);

  protected readonly canSendLineSummary = computed(() => {
    const state = this.lineState();
    // The card is about a finished night: the page is also reachable mid-session from the dashboard.
    return this.owner() && state !== null && state.available && !state.sent && this.summary()?.session.endedAt != null;
  });

  /**
   * The owner's DM-linked group: the bot sends the card to the host, who shares it to a LINE
   * chat through the LIFF page. The link stays after the card went out, since the host may
   * share it to more than one chat.
   */
  protected readonly shareUrl = computed(() => {
    const state = this.lineState();
    if (!this.owner() || state === null || !state.available || state.target !== 'host') return null;
    return this.summary()?.session.endedAt != null ? state.shareUrl : null;
  });

  /** The line under the title about the card, or null when there is nothing to say. */
  protected readonly lineSummaryMessage = computed((): string | null => {
    const state = this.lineState();
    if (!this.owner() || state === null) return null;
    const outcome = this.lineOutcome();
    const host = state.target === 'host';
    if (state.sent || outcome === 'sent' || outcome === 'already-sent') {
      return host
        ? $localize`:@@summary.lineHostSent:ส่งการ์ดให้คุณทาง LINE แล้ว`
        : $localize`:@@summary.lineSent:ส่งสรุปเข้ากลุ่ม LINE แล้ว`;
    }
    switch (outcome) {
      case 'busy':
        return $localize`:@@summary.lineBusy:กำลังส่งสรุปอยู่ รอสักครู่แล้วลองใหม่`;
      case 'quota':
        return $localize`:@@summary.lineQuota:โควตาข้อความ LINE เดือนนี้หมดแล้ว ส่งสรุปไม่ได้`;
      case 'failed':
        return host
          ? $localize`:@@summary.lineHostFailed:ส่งการ์ดให้คุณไม่สำเร็จ เพิ่มบอทเป็นเพื่อนอีกครั้งแล้วลองใหม่`
          : $localize`:@@summary.lineFailed:ส่งสรุปเข้ากลุ่ม LINE ไม่สำเร็จ ลองอีกครั้งได้`;
      case 'unavailable':
        return host
          ? $localize`:@@summary.lineHostUnavailable:ส่งการ์ดไม่ได้ ยังไม่ได้ผูกบัญชี LINE ของคุณ หรือแพ็กเกจหมดอายุ`
          : $localize`:@@summary.lineUnavailable:ส่งสรุปไม่ได้ กลุ่มยังไม่ได้เชื่อม LINE หรือแพ็กเกจหมดอายุ`;
      default:
        return null;
    }
  });

  /** The owner's two LINE reads run side by side; neither waits on the other. */
  private loadOwnerCards(): void {
    void this.loadLineSummary();
    void this.loadPaymentPanel().then(() => this.openSheetFromNavigation());
  }

  private async loadLineSummary(): Promise<void> {
    try {
      this.lineState.set(await firstValueFrom(this.lineService.summaryState(this.sessionCode)));
    } catch {
      this.lineState.set(null);
    }
  }

  protected async sendLineSummary(): Promise<void> {
    if (this.lineSending()) return;
    this.lineSending.set(true);
    try {
      const { outcome } = await firstValueFrom(this.lineService.sendSummary(this.sessionCode));
      this.lineOutcome.set(outcome);
      if (outcome === 'sent' || outcome === 'already-sent') {
        this.lineState.update((s) => (s ? { ...s, sent: true } : s));
      }
    } catch {
      this.lineOutcome.set('failed');
    } finally {
      this.lineSending.set(false);
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
      // Shuttles feed the bill: the banner must see a confirmed card go stale.
      void this.loadPaymentPanel();
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
      // Games feed the bill: the banner must see a confirmed card go stale.
      void this.loadPaymentPanel();
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

  // ---- owner-only payment card ----
  private readonly paymentCards = inject(PaymentCardService);
  /** Where the payment card stands, or null while unread or unreadable; the banner needs a successful read. */
  protected readonly paymentPanel = signal<PaymentCardPanel | null>(null);
  protected readonly paymentSheetOpen = signal(false);

  /**
   * Nudges the host to send the card: nothing was confirmed yet, the amounts moved since, or (group target
   * only) the bot has not posted a confirmed card. A host-target send happens in LINE's picker and cannot be
   * observed, so a fresh confirm there is as far as this page can know.
   */
  protected readonly showPaymentBanner = computed(() => {
    const p = this.paymentPanel();
    if (!this.owner() || p === null || !p.ended || p.target === null) return false;
    if (!p.confirmed || p.stale) return true;
    return p.target === 'group' && p.lastSentAt === null;
  });

  protected async loadPaymentPanel(): Promise<void> {
    try {
      this.paymentPanel.set(await firstValueFrom(this.paymentCards.panel(this.sessionCode)));
    } catch {
      this.paymentPanel.set(null);
    }
  }

  /**
   * Right after ending with the payment tick on, the dashboard asks for the sheet through the history state.
   * It opens once, then the flag is dropped (other keys stay) so a refresh does not open it again. When this
   * page's own read failed it opens anyway: the host asked for it, and the panel inside reads for itself and
   * offers a retry.
   */
  private openSheetFromNavigation(): void {
    const state = history.state as { paymentSheet?: boolean } | null;
    if (!state?.paymentSheet) return;
    const rest = { ...state };
    delete rest.paymentSheet;
    history.replaceState(rest, '');
    const p = this.paymentPanel();
    if (p === null || (p.ended && p.target !== null)) this.paymentSheetOpen.set(true);
  }

  protected openPaymentSheet(): void {
    this.paymentSheetOpen.set(true);
  }

  /** Closing sends nothing; the page reads the card again so the banner matches what the sheet left behind. */
  protected closePaymentSheet(): void {
    this.paymentSheetOpen.set(false);
    void this.loadPaymentPanel();
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
      if (authed) void this.loadInventory().then(() => (this.owner() ? this.loadOwnerCards() : undefined));
    });

    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.summaryResource = httpResource<Summary>(
      () => `${environment.apiBaseUrl}/sessions/${this.sessionCode}/summary`
    );
  }
}
