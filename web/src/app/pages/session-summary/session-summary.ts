import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';
import { environment } from '../../../environments/environment';
import { SceneHost } from '../../core/three/scene-host';
import { formatMinutes } from '../../core/game-duration';
import { formatShuttlePriceInput } from '../../core/shuttle-money';
import {
  ShuttleDetailsDialog,
  type ShuttleDetailsPatch,
} from '../../shared/shuttle-details-dialog/shuttle-details-dialog';
import type { SessionSummary as Summary } from '../../core/session-summary.model';

@Component({
  selector: 'app-session-summary',
  imports: [RouterLink, SceneHost, ShuttleDetailsDialog],
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
    void auth.check().then((authed) => this.isHost.set(authed));

    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.summaryResource = httpResource<Summary>(
      () => `${environment.apiBaseUrl}/sessions/${this.sessionCode}/summary`
    );
  }
}
