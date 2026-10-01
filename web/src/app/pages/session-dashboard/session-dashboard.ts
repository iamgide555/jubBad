import { Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { RosterService } from '../../core/roster.service';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';
import { resolvePlayerNames } from '../../core/player-names';
import { buildWaitingList } from '../../core/waiting-time';
import { SwapSelectionService, type SwapPick } from '../../core/swap-selection.service';
import { FlipListDirective } from '../../core/motion/flip-list.directive';
import { Odometer } from '../../core/motion/odometer';
import { PressDirective } from '../../core/motion/press.directive';
import { RevealDirective } from '../../core/motion/reveal.directive';
import { CourtPanel } from './court-panel/court-panel';
import { CourtLabelEditor } from './court-label-editor/court-label-editor';
import { labelForCourt } from '../../core/court-label';
import {
  ShuttleDetailsDialog,
  type ShuttleDetailsPatch,
} from '../../shared/shuttle-details-dialog/shuttle-details-dialog';
import { AddWalkInDialog } from '../../shared/add-walk-in-dialog/add-walk-in-dialog';
import { AddRuleDialog } from '../../shared/add-rule-dialog/add-rule-dialog';
import { LevelPicker } from '../../shared/level-picker/level-picker';
import type { Player } from '../../../../../engines/fuzzy-match.ts';
import type { GroupLevelsResponse } from '../../core/group-levels.model';
import { levelsErrorMessage } from '../../core/group-levels.model';
import type { Level } from '../../../../../engines/levels.ts';
import { describeRules, ruleErrorMessage, ruleKindLabel, type CreatePairRuleRequest } from '../../core/pair-rule.model';
import type { PlayerStat } from '../../core/stats.model';
import type { PlayerPanelRow } from '../../core/player-panel.model';

@Component({
  selector: 'app-session-dashboard',
  imports: [
    CourtPanel,
    CourtLabelEditor,
    RouterLink,
    FlipListDirective,
    Odometer,
    PressDirective,
    RevealDirective,
    ShuttleDetailsDialog,
    AddWalkInDialog,
    AddRuleDialog,
    LevelPicker,
  ],
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

  /** Same real games-played count shown on the court cards, looked up for a
   *  waiting player — so the queue answers "how much have they played" next
   *  to "how long have they waited", not just the latter. */
  protected gamesFor(playerId: string): number {
    return this.gamesPlayed()[playerId] ?? 0;
  }

  /**
   * The roster chips double as the rest control, so each one needs its id and
   * whether it is resting — not just a display name.
   */
  /**
   * Host-only, so read separately from the public `session()` poll rather
   * than folded into it (see Session.mode's doc comment). Loaded once
   * up front and refreshed alongside the session poll and after a walk-in
   * or level edit — never critical-path: a load failure just means no
   * badges, not a broken dashboard.
   */
  protected readonly levels = signal<Record<string, Level | null>>({});

  private async loadLevels(): Promise<void> {
    try {
      this.levels.set(await this.liveSession.getLevels());
    } catch {
      // Badges are a nice-to-have; leave whatever was last loaded (or empty).
    }
  }

  /**
   * Player panel (C1a): every roster player's level, resting state,
   * tonight's played/won/lost, and their rating as a difference from the
   * level's seed. Lazily fetched — the request only fires while `panelOpen`
   * is true, so a host who never opens it never pays for it — and reloaded
   * explicitly after a level edit made from inside the panel, since that
   * write goes through the groups route, not a session mutation, so it
   * never touches `sessionResource` (the signal `statsResource` above rides
   * on for its own free reload).
   *
   * A native modal, not an inline expand: a long roster used to push the
   * court toolbar and every court panel down the page, which cost the host
   * their place on the courts they were about to act on (same defect fixed
   * for level-picker's compact mode).
   */
  protected readonly panelOpen = signal(false);

  private readonly playerPanelDialog = viewChild.required<ElementRef<HTMLDialogElement>>(
    'playerPanelDialog'
  );

  private readonly playerPanelResource = httpResource<PlayerPanelRow[]>(() => {
    const code = this.session()?.code;
    return this.panelOpen() && code
      ? `${environment.apiBaseUrl}/sessions/${code}/players`
      : undefined;
  });

  protected readonly playerPanel = computed<PlayerPanelRow[]>(() => {
    if (this.playerPanelResource.error()) return [];
    return this.playerPanelResource.value() ?? [];
  });

  protected openPlayerPanel(): void {
    this.panelOpen.set(true);
    this.playerPanelDialog().nativeElement.showModal();
  }

  protected closePlayerPanel(): void {
    this.panelOpen.set(false);
    this.playerPanelDialog().nativeElement.close();
  }

  /** Syncs state back for a browser-initiated close (Escape fires 'cancel' then 'close'). */
  protected onPlayerPanelDialogClose(): void {
    this.panelOpen.set(false);
  }

  /** e.g. 50 -> "+50", 0 -> "+0", -20 -> "-20" — the host always reads a
   *  signed difference from the level's seed, never a bare number. */
  protected formatRatingDelta(delta: number): string {
    return delta >= 0 ? `+${delta}` : `${delta}`;
  }

  /**
   * The group's ordered ladder (host feedback F), read once the session names its group.
   * A failed read leaves it null and every level choice disabled: nothing is offered from a guess.
   */
  protected readonly ladder = signal<GroupLevelsResponse | null>(null);
  protected readonly panelLevelError = signal<string | null>(null);

  protected async loadLadder(): Promise<void> {
    const groupCode = this.session()?.groupCode;
    if (!groupCode) return;
    try {
      this.ladder.set(await firstValueFrom(this.roster.getGroupLevels(groupCode)));
    } catch {
      this.ladder.set(null);
    }
  }

  protected async setPanelLevel(playerId: string, level: Level | null): Promise<void> {
    const groupCode = this.session()?.groupCode;
    const revision = this.ladder()?.revision;
    if (!groupCode || revision === undefined) return;
    this.panelLevelError.set(null);
    try {
      await firstValueFrom(this.roster.updatePlayerLevel(groupCode, playerId, level, revision));
    } catch (err) {
      // The panel reload below shows whatever the server actually has —
      // a failed save just means the chip snaps back to its previous value.
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      this.panelLevelError.set(levelsErrorMessage(code) ?? $localize`:@@dashboard.levelSaveFailed:บันทึกระดับไม่สำเร็จ`);
      void this.loadLadder();
    }
    this.playerPanelResource.reload();
    void this.loadLevels();
  }

  readonly rosterEntries = computed(() => {
    const session = this.session();
    if (!session) return [];
    const resting = new Set(session.restingPlayerIds);
    const names = resolvePlayerNames(session.rosterPlayerIds, this.players());
    const levels = this.levels();
    return session.rosterPlayerIds.map((id, i) => ({
      id,
      name: names[i],
      resting: resting.has(id),
      level: levels[id] ?? null,
    }));
  });

  readonly waitlistNames = computed(() => {
    const session = this.session();
    if (!session) return [];
    return resolvePlayerNames(session.waitlistPlayerIds, this.players());
  });

  readonly courtNumbers = computed(() => this.liveSession.courts().map((_, i) => i + 1));

  /** Courts above the current count that still have matches or a label —
   *  renamable after the session ends so past results read correctly. */
  readonly retiredCourtNumbers = computed(() => {
    const session = this.session();
    if (!session) return [];
    const from = (session.courtCount ?? 0) + 1;
    return Array.from({ length: Math.max(0, session.editableCourtCount - from + 1) }, (_, i) => from + i);
  });

  protected labelFor(courtNumber: number): string {
    return labelForCourt(this.liveSession.courtLabels(), courtNumber);
  }

  /**
   * Ticks so the displayed wait times advance on their own. Minute resolution,
   * so a 30s tick is enough to never look more than half a minute stale.
   */
  private readonly now = signal(Date.now());
  private readonly clock = setInterval(() => this.now.set(Date.now()), 30_000);
  private readonly refreshInterval = setInterval(() => {
    this.liveSession.refresh();
    void this.loadLevels();
    void this.liveSession.loadSessionRules();
  }, 30_000);
  private readonly onWindowFocus = () => {
    this.liveSession.refresh();
    void this.liveSession.loadSessionRules();
  };

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
      session.queueGames,
      session.queueBy
    );
  });

  readonly ended = computed(() => this.session()?.endedAt != null);
  readonly mode = computed(() => this.session()?.mode ?? 'variety');
  /** Custom session only: true when at least one court is set to ระดับ, so
   *  the shared waiting list (which stays games-then-wait in a custom
   *  session — see waiting-time.ts) can warn that a level court may pick
   *  out of that order. */
  readonly anyCourtIsLevel = computed(() =>
    this.liveSession.courts().some((c) => c.mode === 'level')
  );
  readonly courtCount = computed(() => this.courtNumbers().length);
  readonly anyCourtIdle = computed(() =>
    this.liveSession.courts().some((c) => c.status === 'idle')
  );
  readonly copied = signal(false);
  /** Carries either a failed shuttle-details save or a failed end, whichever
   *  the host's confirm attempt hit — rendered inside the end-session dialog. */
  protected readonly endSessionError = signal<string | null>(null);
  protected readonly endSessionBusy = signal(false);
  private readonly endDialog = viewChild<ShuttleDetailsDialog>('endDialog');
  readonly clipboardFallback = signal<string | null>(null);

  constructor(
    protected liveSession: LiveSessionService,
    private router: Router,
    private roster: RosterService
  ) {
    window.addEventListener('focus', this.onWindowFocus);
    // Once the first session read names the group, read its ladder.
    effect(() => {
      if (this.session()?.groupCode) void this.loadLadder();
    });
    void this.loadLevels();
    void this.liveSession.loadSessionRules();
  }

  /**
   * The group's pair rules, each switchable for tonight only — the group
   * rule itself is edited on the player roster page, never here.
   */
  protected readonly sessionRuleRows = computed(() => {
    const state = this.liveSession.sessionRules();
    if (!state) return [];
    const off = new Set(state.disabledRuleIds);
    const nameOf = (id: string) => this.players().find((p) => p.id === id)?.name ?? '?';
    return state.rules.map((r) => ({
      id: r.id,
      players: `${nameOf(r.playerAId)} · ${nameOf(r.playerBId)}`,
      kind: ruleKindLabel(r.kind),
      enabled: !off.has(r.id),
    }));
  });

  protected readonly rulesError = signal<string | null>(null);

  async toggleSessionRule(ruleId: string, enabled: boolean): Promise<void> {
    this.rulesError.set(null);
    const result = await this.liveSession.toggleSessionRule(ruleId, enabled);
    this.rulesError.set(result.error ?? null);
  }

  private describe(ruleIds: readonly string[]): string {
    return describeRules(ruleIds, this.liveSession.sessionRules()?.rules ?? [], this.players());
  }

  readonly rosterError = signal<string | null>(null);

  private readonly addRuleDialog = viewChild<AddRuleDialog>('addRuleDialog');
  protected readonly addRuleSaving = signal(false);
  protected readonly addRuleError = signal<string | null>(null);

  /** Tonight's roster, for the add-rule pickers — resting players included,
   *  since a rule stays on the group and applies whenever both are active. */
  protected readonly rosterPickList = computed(() =>
    this.rosterEntries().map((e) => ({ id: e.id, name: e.name }))
  );

  protected openAddRuleDialog(): void {
    this.addRuleError.set(null);
    this.addRuleDialog()?.open();
  }

  /** Creates a normal group rule (it outlives tonight), then re-reads the
   *  session's rules so the new row and its tonight switch appear. */
  protected async submitAddRule(rule: CreatePairRuleRequest): Promise<void> {
    const groupCode = this.session()?.groupCode;
    if (!groupCode) return;
    this.addRuleSaving.set(true);
    this.addRuleError.set(null);
    try {
      await firstValueFrom(this.roster.createRule(groupCode, rule));
    } catch (err) {
      this.addRuleSaving.set(false);
      this.addRuleError.set(ruleErrorMessage(err));
      return;
    }
    await this.liveSession.loadSessionRules();
    this.addRuleSaving.set(false);
    this.addRuleDialog()?.close();
  }

  private readonly walkInDialog = viewChild<AddWalkInDialog>('walkInDialog');
  protected readonly walkInSaving = signal(false);
  protected readonly walkInError = signal<string | null>(null);

  protected readonly rosterPlayerIds = computed(() => new Set(this.session()?.rosterPlayerIds ?? []));

  protected openWalkInDialog(): void {
    this.walkInError.set(null);
    this.walkInDialog()?.open();
  }

  protected async submitWalkIn(
    input: { playerId: string } | { name: string; level?: Level }
  ): Promise<void> {
    this.walkInSaving.set(true);
    this.walkInError.set(null);
    // A level choice carries the ladder revision the host picked it from.
    const withRevision =
      'name' in input && input.level
        ? { ...input, expectedLadderRevision: this.ladder()?.revision }
        : input;
    const result = await this.liveSession.addWalkIn(withRevision);
    this.walkInSaving.set(false);
    if (!result.ok) {
      this.walkInError.set(result.error ?? null);
      void this.loadLadder();
      return;
    }
    this.walkInDialog()?.close();
    void this.loadLevels();
  }

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
    // Rule-blocked and search-limited courts are reported even when other
    // courts filled, and never folded into "not enough players".
    const notes: string[] = [];
    for (const blocked of result.blocked ?? []) {
      const court = this.labelFor(blocked.courtNumber);
      const message = $localize`:@@dashboard.courtRulesBlocked:คอร์ท ${court}:court: จัดไม่ได้เพราะกฎการจับคู่`;
      const rules = this.describe(blocked.ruleIds);
      notes.push(rules ? `${message}: ${rules}` : message);
    }
    if (result.inconclusive?.length) {
      const courts = result.inconclusive.map((n) => this.labelFor(n)).join(', ');
      notes.push(
        $localize`:@@dashboard.courtsSearchLimit:คอร์ท ${courts}:courts: หาคู่ตามกฎไม่ทัน ลองใหม่หรือปิดกฎบางข้อคืนนี้`
      );
    }
    if (!result.ok && result.reason === 'not-enough-players') {
      notes.push($localize`:@@dashboard.notEnoughToFill:ผู้เล่นไม่พอ`);
    }
    if (result.error) notes.push(result.error);
    this.rosterError.set(notes.length > 0 ? notes.join(' · ') : null);
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

  async setMode(mode: 'variety' | 'balanced' | 'level' | 'custom'): Promise<void> {
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
      const number = this.labelFor(i + 1);
      if (court.status !== 'active') {
        lines.push($localize`:@@share.courtIdle:คอร์ท ${number}:n:: ว่าง`);
        continue;
      }
      const teamA = resolvePlayerNames(court.teamA, this.players()).join(' + ');
      const teamB = resolvePlayerNames(court.teamB, this.players()).join(' + ');
      lines.push(`${$localize`:@@share.court:คอร์ท ${number}:n:`}: ${teamA} vs ${teamB}`);
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

  /**
   * Opens the shared shuttle-details dialog as the (only) confirmation step
   * before ending a session — there was previously no confirmation at all.
   */
  protected openEndSession(): void {
    this.endSessionError.set(null);
    this.endDialog()?.open();
  }

  /**
   * Save-then-end, in that order: if the host typed shuttle numbers and the
   * end itself then fails (e.g. unfinished pairings), the numbers are not
   * lost — they are already persisted, and `setShuttleDetails` reloads
   * `sessionResource`, so a re-open of the dialog shows the committed values
   * rather than making the host retype them.
   */
  protected async confirmEndSession(patch: ShuttleDetailsPatch): Promise<void> {
    if (this.endSessionBusy()) return;
    this.endSessionBusy.set(true);
    this.endSessionError.set(null);
    try {
      if (Object.keys(patch).length > 0) {
        const saved = await this.liveSession.setShuttleDetails(patch);
        if (!saved.ok) {
          this.endSessionError.set(
            saved.error ?? $localize`:@@err.shuttleDetails:บันทึกข้อมูลลูกแบดไม่สำเร็จ`
          );
          return;
        }
      }
      const result = await this.liveSession.endSession();
      if (!result.ok) {
        this.endSessionError.set(result.error ?? $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
        return;
      }
      this.endDialog()?.close();
      this.router.navigateByUrl(`/s/${this.session()!.code}/summary`);
    } finally {
      this.endSessionBusy.set(false);
    }
  }
}
