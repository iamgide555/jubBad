import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  attachDecisions,
  claimedPlayerIds,
  exactPlayerMatch,
  literalKey,
  literalNewNameDrafts,
  searchCandidates,
  type ManualMatchState,
  type NameReview,
  type PlayerCandidate,
} from '../../core/roster-review';
import { RosterService, type ParseRosterResponse } from '../../core/roster.service';
import { RosterDraftService, type RosterDraft } from '../../core/roster-draft.service';
import { resolvePlayerNames } from '../../core/player-names';
import { PressDirective } from '../../core/motion/press.directive';
import { RevealDirective } from '../../core/motion/reveal.directive';
import { Icon } from '../../shared/icon/icon';
import { LevelPicker } from '../../shared/level-picker/level-picker';
import type { Player } from '../../../../../engines/fuzzy-match.ts';
import type { Level } from '../../../../../engines/levels.ts';
import { levelsErrorMessage, type GroupLevelsResponse } from '../../core/group-levels.model';

/** Local calendar date as `YYYY-MM-DD` — `Date#toISOString` reads UTC, which
 *  rolls over a day early/late for anyone west/east of it in the evening,
 *  exactly when a host is starting tonight's session. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** How long "clear list" can be taken back. */
const UNDO_MS = 8000;

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, PressDirective, RevealDirective, Icon, LevelPicker],
  templateUrl: './group-entry.html',
  styleUrl: './group-entry.css',
})
export class GroupEntry {
  protected readonly groupCode: string;
  readonly state = signal<'paste' | 'confirm'>('paste');
  readonly rawText = signal('');
  readonly date = signal('');
  readonly venue = signal('');
  readonly courtCount = signal<number | null>(null);
  readonly rosterReviews = signal<NameReview[]>([]);
  readonly waitlistReviews = signal<NameReview[]>([]);
  readonly groupName = signal('');
  readonly lastSessionCode = signal<string | null>(null);
  readonly warnings = signal<string[]>([]);
  readonly unrecognizedLines = signal<string[]>([]);
  readonly pasteError = signal<string | null>(null);
  readonly confirmError = signal<string | null>(null);
  readonly isParsing = signal(false);
  readonly isSubmitting = signal(false);

  /** The saved group this roster is for. Not found is a dead end here: groups are created at /groups/new. */
  readonly groupStatus = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  private readonly drafts = inject(RosterDraftService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly document = inject(DOCUMENT);
  /** Where focus goes when the control the host just used disappears (clear, undo, edit-paste). */
  private readonly undoButton = viewChild<ElementRef<HTMLButtonElement>>('undoButton');
  private readonly clearButton = viewChild<ElementRef<HTMLButtonElement>>('clearButton');
  private readonly rosterText = viewChild<ElementRef<HTMLTextAreaElement>>('rosterText');
  /** Set once the session exists, so leaving afterwards does not save a stale draft back. */
  private sessionCreated = false;
  /** This screen came back from a draft: the host is mid-task here, so it is not a fresh start to autofocus. */
  private restoredDraft = false;
  /** The screen was left; a late clipboard read must not act on it. */
  private destroyed = false;
  /** A clipboard read is waiting on the browser (a permission prompt, iOS's "Paste" callout). */
  private readingClipboard = false;
  /** What the clipboard button last had to say — muted, never an error: typing the paste is always open. */
  readonly clipboardNote = signal<string | null>(null);

  /** One full doubles court — the default court format — is the floor for a
   *  session worth starting. Below it the dashboard would open to a court
   *  that can't propose anything. */
  readonly minRoster = 4;

  /** Group's known players, loaded once by `parse()`; converted to a signal
   * so the manual-add search/candidate state below can be computed from it. */
  private readonly players = signal<Player[]>([]);
  private creationIdempotencyKey: string | null = null;

  /** Manual roster add — search field text (Task 2 binds this two-way). */
  readonly manualQuery = signal('');
  /** Manual roster add — surfaces a whitespace-only/duplicate-draft rejection. */
  readonly manualAddError = signal<string | null>(null);

  /**
   * Task 2 — combobox UI state for the manual-add field. None of this is
   * part of Task 1's interface; it is pure presentation bookkeeping the
   * template needs to implement an accessible combobox on top of Task 1's
   * reactive data. `manualActiveIndex` is the keyboard-highlighted option
   * (-1 = none), indexing into `manualCandidates()` and then, one past the
   * end, the trailing "add as new" option. `manualSuggestionsDismissed` lets
   * Escape (or blur) close the popup without erasing the typed query.
   * `manualStatusMessage` feeds the added/removed screen-reader
   * announcement.
   */
  readonly manualActiveIndex = signal(-1);
  readonly manualSuggestionsDismissed = signal(false);
  readonly manualStatusMessage = signal('');

  /**
   * Same tracking pattern as `openReviews` below: object identity, not a
   * field on `NameReview` — manual bookkeeping is client-only and must never
   * appear on the wire. A manual addition is otherwise a plain accepted
   * `NameReview`, indistinguishable from an imported one.
   */
  private readonly manualReviews = new Set<NameReview>();

  /** Existing player IDs already accepted by either list — imported or
   * manual, no distinction. Recomputed from the review signals, so removing
   * a manual addition (or flipping an imported decision) makes an ID
   * searchable again automatically. */
  readonly claimedIds = computed(() => claimedPlayerIds(this.rosterReviews(), this.waitlistReviews()));

  /**
   * How many distinct players the roster will actually resolve to on
   * confirm — mirrors the server's own dedup in `SessionsService`'s
   * `resolve()` (accept-non-new rows collapse onto their `playerId`; an
   * accepted `duplicate` collapses onto the same id as the row it names, so
   * it does not add a slot). Gates `canConfirm()` against `minRoster`
   * without waiting on a round trip to find out the roster was too small.
   */
  readonly acceptedRosterCount = computed(() => {
    const ids = new Set<string>();
    let newCount = 0;
    for (const review of this.rosterReviews()) {
      if (review.decision === 'accept' && review.match.type !== 'new') {
        ids.add(review.match.playerId);
      } else {
        newCount++;
      }
    }
    return ids.size + newCount;
  });

  /** Ranked search results for the manual-add field, excluding already
   * claimed players. Empty when the query is blank. */
  readonly manualCandidates = computed<PlayerCandidate[]>(() =>
    searchCandidates(this.manualQuery(), this.players(), this.claimedIds())
  );

  /** Which of no-match / exact-match-available / exact-match-already-selected
   * the current query is in — drives whether Task 2's UI shows "Add as new",
   * "select existing", or "already selected". */
  readonly manualMatchState = computed<ManualMatchState>(() => {
    const query = this.manualQuery().trim();
    if (!query) return { kind: 'no-match' };
    const player = exactPlayerMatch(query, this.players());
    if (!player) return { kind: 'no-match' };
    return this.claimedIds().has(player.id)
      ? { kind: 'exact-match-already-selected', player }
      : { kind: 'exact-match-available', player };
  });

  /**
   * Task 2 — gates the "Add as new" affordance. `manualMatchState().kind ===
   * 'no-match'` alone can't tell "nothing typed" apart from "genuinely no
   * match", so this checks the trimmed query directly; it only shows the
   * affordance in the genuine no-match state — an exact match (claimed or
   * not) should always be offered/selected instead of creating a duplicate
   * profile, and `addNew()`'s own guard would reject it anyway.
   */
  readonly manualShowAddNew = computed(
    () => this.manualQuery().trim().length > 0 && this.manualMatchState().kind === 'no-match'
  );

  /**
   * Task 2 — whether the suggestion popup should render: something to show
   * (a candidate or the add-new option), not dismissed via Escape/blur, and
   * not while a submit is in flight.
   */
  readonly manualShowSuggestions = computed(
    () =>
      !this.isSubmitting() &&
      !this.manualSuggestionsDismissed() &&
      (this.manualCandidates().length > 0 || this.manualShowAddNew())
  );

  /**
   * Which reviews are showing the open yes/no toggle right now, tracked by
   * object identity rather than as a field on NameReview — it is pure UI
   * state, never sent to the server. `fuzzy`/`duplicate` rows start in this
   * set (a real judgment call the host must make); `exact` rows don't
   * (already correct, nothing to decide). Any decision change replaces the
   * review with a new object (see `setDecision`), which drops it out of this
   * set automatically — so answering a question collapses it back down with
   * no separate "close" step, and reopening it via the small "change answer"
   * link is the only way back in.
   */
  private readonly openReviews = new Set<NameReview>();

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    private router: Router
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    const draft = this.drafts.get(this.groupCode);
    if (draft) {
      this.applyDraft(draft);
      this.restoredDraft = true;
    }
    void this.loadGroup();
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.clearUndo();
      this.persistDraft();
    });
  }

  async loadGroup(): Promise<void> {
    this.groupStatus.set('loading');
    try {
      const group = await firstValueFrom(this.rosterService.getGroup(this.groupCode));
      this.groupName.set(group.name ?? '');
      this.lastSessionCode.set(group.lastSessionCode);
      this.groupStatus.set('ready');
    } catch (err) {
      this.groupStatus.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
      return;
    }
    this.focusEmptyPasteBox();
  }

  /**
   * The weekly job is to paste, so a fresh start puts the cursor in the box. Only a fresh one: a
   * restored draft, a review, a pending undo, or text already typed means the host is already
   * somewhere, and a group that answers late must not pull them away from it. Not on a touch
   * screen either: focus there opens the soft keyboard over the one-tap clipboard button, and the
   * host reaches the box with a tap anyway. Outside loadGroup's try, so a render failure here is
   * not reported as the group failing to load.
   */
  private focusEmptyPasteBox(): void {
    if (this.restoredDraft || this.state() !== 'paste' || this.rawText() || this.undoSnapshot()) return;
    // No matchMedia (jsdom, very old browsers) is not a touch screen: keep the autofocus.
    if (this.document.defaultView?.matchMedia?.('(pointer: fine)')?.matches === false) return;
    this.focusAfterRender(this.rosterText);
  }

  /**
   * Leaving for group settings must not lose a roster in progress. An empty
   * paste box has nothing worth keeping, and a created session has already
   * consumed the draft.
   */
  private persistDraft(): void {
    if (this.sessionCreated) return;
    if (this.state() === 'paste' && !this.rawText().trim()) {
      this.drafts.clear(this.groupCode);
      return;
    }
    this.drafts.save(this.groupCode, this.snapshotDraft());
  }

  /**
   * The whole screen as it stands, for `persistDraft` (leaving) and `discardDraft` (undo).
   * The Sets are copied: the live ones are cleared on discard, and must not empty the snapshot with them.
   */
  private snapshotDraft(): RosterDraft {
    return {
      state: this.state(),
      rawText: this.rawText(),
      date: this.date(),
      venue: this.venue(),
      courtCount: this.courtCount(),
      warnings: this.warnings(),
      unrecognizedLines: this.unrecognizedLines(),
      rosterReviews: this.rosterReviews(),
      waitlistReviews: this.waitlistReviews(),
      players: this.players(),
      manualReviews: new Set(this.manualReviews),
      openReviews: new Set(this.openReviews),
      idempotencyKey: this.creationIdempotencyKey,
    };
  }

  private applyDraft(draft: RosterDraft): void {
    this.rawText.set(draft.rawText);
    this.date.set(draft.date);
    this.venue.set(draft.venue);
    this.courtCount.set(draft.courtCount);
    this.warnings.set(draft.warnings);
    this.unrecognizedLines.set(draft.unrecognizedLines);
    this.rosterReviews.set(draft.rosterReviews);
    this.waitlistReviews.set(draft.waitlistReviews);
    this.players.set(draft.players);
    for (const r of draft.manualReviews) this.manualReviews.add(r);
    for (const r of draft.openReviews) this.openReviews.add(r);
    this.creationIdempotencyKey = draft.idempotencyKey;
    this.state.set(draft.state);
    if (draft.state === 'confirm') void this.loadLadder();
  }

  /**
   * What the last "clear list" threw away, held for `UNDO_MS` so the host can
   * take it back. Never the live draft: `persistDraft` reads the live signals,
   * so leaving with an undo pending saves the empty paste box, not this.
   */
  readonly undoSnapshot = signal<RosterDraft | null>(null);
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  /** Throw the roster away and start from an empty paste box — undoable for a few seconds. */
  discardDraft(): void {
    // Only the review has a list to clear. Anywhere else this would replace a
    // pending undo with a snapshot of an empty paste box.
    if (this.state() !== 'confirm') return;
    const snapshot = this.snapshotDraft();
    this.drafts.clear(this.groupCode);
    this.rawText.set('');
    this.rosterReviews.set([]);
    this.waitlistReviews.set([]);
    this.manualReviews.clear();
    this.openReviews.clear();
    this.creationIdempotencyKey = null;
    this.pasteError.set(null);
    this.confirmError.set(null);
    this.state.set('paste');
    this.clearUndo();
    this.undoSnapshot.set(snapshot);
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      // The notice is about to go: a host still on its button lands in the paste box, not on the page.
      if (this.document.activeElement === this.undoButton()?.nativeElement) this.rosterText()?.nativeElement.focus();
      this.undoSnapshot.set(null);
    }, UNDO_MS);
    // The clear button just disappeared with the review: put focus on the way back.
    this.focusAfterRender(this.undoButton);
  }

  /** Puts back exactly what the last clear threw away. Never after the session exists. */
  undoDiscard(): void {
    const snapshot = this.undoSnapshot();
    this.clearUndo();
    if (!snapshot || this.sessionCreated) return;
    this.applyDraft(snapshot);
    this.focusAfterRender(this.clearButton);
  }

  /**
   * Renders now, then focuses — the target only exists once the state change
   * has rendered. Synchronous detectChanges, like GroupHome.restoreFromQuery;
   * no afterNextRender (see core/motion/reveal.directive.ts).
   */
  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    this.cdr.detectChanges();
    target()?.nativeElement.focus();
  }

  /** Withdraws the undo offer: the host has moved on (new text, a new parse, a manual start, a session, or leaving). */
  private clearUndo(): void {
    if (this.undoTimer !== null) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoSnapshot.set(null);
  }

  /** Back from the review to the pasted message, text kept. The reviews stay until the next parse replaces them. */
  editPaste(): void {
    if (this.isSubmitting()) return;
    this.state.set('paste');
    this.focusAfterRender(this.rosterText);
  }

  /** The paste box's input. Any new text means the host has moved on from the list they cleared. */
  onRawTextChange(value: string): void {
    this.rawText.set(value);
    this.clearUndo();
    this.clipboardNote.set(null);
  }

  /**
   * Labels the button for `decision`, not the review's current decision — the
   * template renders one button per choice so the host picks between two
   * visible options rather than reading one button's label to guess what
   * tapping it will do.
   *
   * A duplicate asks a different question from an exact/fuzzy suggestion.
   * Exact/fuzzy is "did you mean this player?"; duplicate is "is this the
   * same person as the slot above?", where accepting removes a slot rather
   * than adding one. Sharing the yes/no wording made the destructive answer
   * read as the agreeable one.
   */
  decisionLabel(review: NameReview, decision: NameReview['decision']): string {
    if (review.match.type === 'duplicate') {
      return decision === 'accept'
        ? $localize`:@@entry.decisionSamePerson:คนเดียวกัน`
        : $localize`:@@entry.decisionDifferentPerson:คนละคน`;
    }
    return decision === 'accept'
      ? $localize`:@@entry.decisionYes:ใช่`
      : $localize`:@@entry.decisionNew:ไม่ใช่ เพิ่มใหม่`;
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players())[0];
  }

  /**
   * The typed text ("เกีย") is what the host pasted, not what to show once
   * they've confirmed it is an existing player ("เกียร์") — showing the raw
   * paste after confirming the match just reads as if the confirmation did
   * nothing. `duplicate` keeps the typed text even when accepted: its tag
   * already names the player it merges into, and the row itself disappears
   * from the roster on submit rather than taking on that player's identity.
   */
  displayName(review: NameReview): string {
    if (review.decision === 'accept' && review.match.type === 'exact') {
      return this.playerName(review.match.playerId);
    }
    if (review.decision === 'accept' && review.match.type === 'fuzzy') {
      return this.playerName(review.match.playerId);
    }
    return review.inputName;
  }

  /**
   * `exact` starts closed (nothing to decide) and `fuzzy`/`duplicate` start
   * open (see `openReviews`); either way, this is what actually shows the
   * toggle right now, regardless of why.
   */
  isOpen(review: NameReview): boolean {
    return this.openReviews.has(review);
  }

  openChoice(review: NameReview): void {
    this.openReviews.add(review);
  }

  async parse(): Promise<void> {
    if (this.isParsing()) return;
    this.pasteError.set(null);

    if (!this.rawText().trim()) {
      this.pasteError.set($localize`:@@entry.errNoText:วางข้อความรายชื่อก่อน`);
      return;
    }

    this.clearUndo();
    this.isParsing.set(true);
    try {
      const result = await firstValueFrom(
        this.rosterService.parseRoster(this.groupCode, this.groupName() || this.groupCode, this.rawText())
      );

      if (result.rosterReviews.length === 0) {
        this.pasteError.set(
          $localize`:@@entry.errNoPlayers:ไม่พบรายชื่อผู้เล่น — ตรวจว่าแต่ละชื่ออยู่บรรทัดของตัวเองและมีเลขนำหน้า (เช่น "1. ชื่อ")`
        );
        return;
      }

      const players = await firstValueFrom(this.rosterService.getPlayers(this.groupCode));
      this.enterConfirm(result, players);
    } catch {
      this.pasteError.set($localize`:@@entry.parseFailed:อ่านรายชื่อไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.isParsing.set(false);
    }
  }

  /**
   * One-tap paste of this week's LINE message: read the clipboard, then parse exactly as a typed
   * paste would. Whatever parse() reports shows the way it does for typed text.
   *
   * UNVERIFIED: the Clipboard API's readText has not been tried inside LINE's in-app browser or on
   * iOS Safari, which shows its own "Paste" callout the host must tap. Every failure therefore ends
   * at the typed-paste path (a note and the cursor in the box), so at worst this costs a tap and
   * never stands in the way of pasting by hand.
   */
  async pasteFromClipboard(): Promise<void> {
    // isParsing: the text being parsed must not be replaced under it. readingClipboard: a second
    // tap while the browser's callout is up must not open a second read.
    if (this.isParsing() || this.readingClipboard || this.groupStatus() !== 'ready') return;
    this.clipboardNote.set(null);
    this.pasteError.set(null);

    this.readingClipboard = true;
    // No await before this: iOS only allows the read inside the tap that asked for it.
    const text = await this.readClipboard();
    this.readingClipboard = false;
    // The host may have gone elsewhere while the read waited on a prompt.
    if (this.destroyed || this.isParsing() || this.state() !== 'paste') return;

    if (text === null) {
      this.clipboardNote.set($localize`:@@entry.clipboardFallback:วางเองในช่องด้านล่างได้เลย`);
      this.rosterText()?.nativeElement.focus();
      return;
    }
    if (!text.trim()) {
      this.clipboardNote.set($localize`:@@entry.clipboardEmpty:คลิปบอร์ดว่างอยู่ คัดลอกข้อความรายชื่อจาก LINE ก่อน`);
      return;
    }
    // Same as typing the text in: a new paste withdraws a pending undo.
    this.onRawTextChange(text);
    await this.parse();
  }

  /** The clipboard's text, or null when it cannot be read: no API, permission refused, or the read threw. */
  private async readClipboard(): Promise<string | null> {
    try {
      return (await navigator.clipboard?.readText?.()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * For a host with nothing to paste (ad-hoc night, no LINE message) — lands
   * on the same confirm step as `parse()`, empty, and the manual add field
   * already there does the rest. The group already exists (it is created at
   * /groups/new), so a manual start only needs the group's players: nothing
   * is parsed.
   */
  async startManual(): Promise<void> {
    if (this.isParsing()) return;
    this.pasteError.set(null);
    this.clearUndo();

    this.isParsing.set(true);
    try {
      const players = await firstValueFrom(this.rosterService.getPlayers(this.groupCode));
      this.rawText.set('');
      this.enterConfirm(
        {
          header: { isoDate: todayIso(), venue: null, courtCount: null },
          warnings: [],
          unrecognizedLines: [],
          rosterReviews: [],
          waitlistReviews: [],
        },
        players
      );
    } catch {
      this.pasteError.set($localize`:@@entry.parseFailed:อ่านรายชื่อไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.isParsing.set(false);
    }
  }

  /** Shared by `parse()` and `startManual()`: applies a parsed (or synthetic
   *  empty) result and drops the confirm screen into its starting state. */
  /**
   * The group's ordered ladder, read once the review opens. Null while unread or unreadable:
   * the level choices are then disabled rather than offered from a guess.
   */
  readonly ladder = signal<GroupLevelsResponse | null>(null);

  private async loadLadder(): Promise<void> {
    try {
      this.ladder.set(await firstValueFrom(this.rosterService.getGroupLevels(this.groupCode)));
    } catch {
      this.ladder.set(null);
    }
  }

  private enterConfirm(result: ParseRosterResponse, players: Player[]): void {
    void this.loadLadder();
    this.date.set(result.header.isoDate ?? '');
    this.venue.set(result.header.venue ?? '');
    this.courtCount.set(result.header.courtCount);
    this.warnings.set(result.warnings);
    this.unrecognizedLines.set(result.unrecognizedLines);

    this.rosterReviews.set(attachDecisions(result.rosterReviews));
    this.waitlistReviews.set(attachDecisions(result.waitlistReviews));
    this.openReviews.clear();
    for (const review of [...this.rosterReviews(), ...this.waitlistReviews()]) {
      if (review.match.type === 'fuzzy' || review.match.type === 'duplicate') {
        this.openReviews.add(review);
      }
    }
    this.players.set(players);

    // A fresh confirm screen replaces the whole review, so any manual
    // additions/search state from a previous parse no longer refer to
    // anything real and must not carry over.
    this.manualReviews.clear();
    this.manualQuery.set('');
    this.manualAddError.set(null);
    this.manualActiveIndex.set(-1);
    this.manualSuggestionsDismissed.set(false);
    this.manualStatusMessage.set('');
    this.clipboardNote.set(null);

    // A fresh parse (or manual start) is a fresh attempt. A key carried over
    // from a failed create would hand back that attempt's session — old roster
    // and all — if it had in fact committed. A restored draft (applyDraft)
    // keeps its key: that is the same attempt after a detour.
    this.creationIdempotencyKey = null;

    this.state.set('confirm');
  }

  canConfirm(): boolean {
    return (
      this.date().length > 0 &&
      this.courtCount() !== null &&
      this.courtCount()! > 0 &&
      this.acceptedRosterCount() >= this.minRoster
    );
  }

  setDecision(review: NameReview, decision: NameReview['decision']): void {
    const apply = (reviews: NameReview[]) =>
      reviews.map((r) => (r === review ? { ...r, decision } : r));
    this.rosterReviews.update(apply);
    this.waitlistReviews.update(apply);
  }

  /** A level on a new player's review chip (C1) — only ever set here for a
   *  `new` row; an existing player's level is edited on the roster page. */
  setLevel(review: NameReview, level: Level | null): void {
    const apply = (reviews: NameReview[]) =>
      reviews.map((r) => (r === review ? { ...r, level: level ?? undefined } : r));
    this.rosterReviews.update(apply);
    this.waitlistReviews.update(apply);
  }

  /**
   * A manual addition/removal is otherwise a plain `NameReview`,
   * indistinguishable from an imported row — this is the only way Task 2's
   * template can tell the two apart, e.g. to show remove/reselect instead of
   * the imported-name yes/no toggle.
   */
  isManualReview(review: NameReview): boolean {
    return this.manualReviews.has(review);
  }

  /**
   * Selects an existing player found via `manualCandidates`. Re-validates
   * eligibility at the moment of the call rather than trusting the rendered
   * list, so a rapid double-click/tap on a candidate that a first click just
   * claimed is a no-op instead of a double add. Always lands in the main
   * roster, never the waitlist (manual additions never go to the waitlist).
   */
  addExisting(playerId: string): void {
    if (this.isSubmitting()) return;
    if (this.claimedIds().has(playerId)) return;
    const player = this.players().find((p) => p.id === playerId);
    if (!player) return;

    const review: NameReview = {
      inputName: player.name,
      match: { type: 'exact', playerId },
      decision: 'accept',
    };
    this.rosterReviews.update((rs) => [...rs, review]);
    this.manualReviews.add(review);
    this.manualQuery.set('');
    this.manualAddError.set(null);
  }

  /**
   * Stages the current search text as a brand-new player (`match.type ===
   * 'new'`) — no player record or ID is created yet, that happens on the
   * server at confirmation. Rejects whitespace-only input and a literal
   * repeat of a draft already staged in either list. Re-checks for a live
   * exact player match as a defensive guard: an exact match should always be
   * offered/selected instead of creating a duplicate profile, even if this
   * is invoked past a stale render.
   */
  addNew(): void {
    if (this.isSubmitting()) return;
    this.manualAddError.set(null);

    const trimmed = this.manualQuery().trim();
    if (!trimmed) {
      this.manualAddError.set($localize`:@@entry.manualAddEmpty:กรุณาพิมพ์ชื่อก่อน`);
      return;
    }
    if (exactPlayerMatch(trimmed, this.players())) {
      this.manualAddError.set(
        $localize`:@@entry.manualAddExactExists:มีผู้เล่นชื่อนี้อยู่แล้ว กรุณาเลือกจากรายการ`
      );
      return;
    }
    const drafts = literalNewNameDrafts(this.rosterReviews(), this.waitlistReviews());
    if (drafts.has(literalKey(trimmed))) {
      this.manualAddError.set($localize`:@@entry.manualAddDuplicate:เพิ่มชื่อนี้ไปแล้ว`);
      return;
    }

    const review: NameReview = { inputName: trimmed, match: { type: 'new' }, decision: 'accept' };
    this.rosterReviews.update((rs) => [...rs, review]);
    this.manualReviews.add(review);
    this.manualQuery.set('');
  }

  /**
   * Removes a manual addition before confirmation. Manual additions only
   * ever land in `rosterReviews` (never the waitlist), so that's the only
   * list this touches. If it was an existing-player addition, the player
   * becomes searchable again automatically once removed — `claimedIds` is
   * derived from the review lists, not tracked separately — unless another
   * accepted row still references the same ID.
   */
  removeManual(review: NameReview): void {
    if (this.isSubmitting() || !this.manualReviews.has(review)) return;
    this.rosterReviews.update((rs) => rs.filter((r) => r !== review));
    this.manualReviews.delete(review);
  }

  /**
   * Task 2 wiring: two-way binds `manualQuery`, and — the carried-over
   * finding from Task 1's review — clears a stale `manualAddError` the
   * moment the host edits the query again, since Task 1 only clears it at
   * the start of a successful `addExisting`/`addNew` call. Also resets the
   * combobox's keyboard highlight and un-dismisses the popup so a fresh
   * keystroke always reopens suggestions.
   */
  onManualQueryChange(value: string): void {
    this.manualQuery.set(value);
    this.manualAddError.set(null);
    this.manualActiveIndex.set(-1);
    this.manualSuggestionsDismissed.set(false);
  }

  onManualFocus(): void {
    this.manualSuggestionsDismissed.set(false);
  }

  onManualBlur(): void {
    this.manualSuggestionsDismissed.set(true);
  }

  /**
   * Task 2 template helper: the exact-match player's name when the query
   * matches a player already claimed by another row, for the "already
   * selected" inline note — null otherwise. Keeps the template from having
   * to narrow `ManualMatchState`'s union itself.
   */
  manualAlreadySelectedName(): string | null {
    const state = this.manualMatchState();
    return state.kind === 'exact-match-already-selected' ? state.player.name : null;
  }

  activeOptionId(): string | null {
    const idx = this.manualActiveIndex();
    return idx >= 0 ? `manual-option-${idx}` : null;
  }

  /**
   * Task 2 — accessible combobox keyboard support: arrow-key navigation
   * through `manualCandidates()` plus the trailing "add as new" option,
   * Enter to act on whichever is highlighted, Escape to dismiss. Guarded by
   * `event.isComposing` so committing Thai IME composition with Enter never
   * doubles as "select" — no existing input in this codebase already
   * guards this, so this follows the standard DOM `isComposing` check
   * directly.
   */
  onManualKeydown(event: KeyboardEvent): void {
    if (event.isComposing || this.isSubmitting()) return;
    const input = event.target as HTMLInputElement;
    const candidates = this.manualCandidates();
    const optionCount = candidates.length + (this.manualShowAddNew() ? 1 : 0);

    switch (event.key) {
      case 'ArrowDown':
        if (optionCount === 0) return;
        event.preventDefault();
        this.manualSuggestionsDismissed.set(false);
        this.manualActiveIndex.update((i) => (i + 1) % optionCount);
        return;
      case 'ArrowUp':
        if (optionCount === 0) return;
        event.preventDefault();
        this.manualSuggestionsDismissed.set(false);
        this.manualActiveIndex.update((i) => (i - 1 + optionCount) % optionCount);
        return;
      case 'Escape':
        event.preventDefault();
        this.manualSuggestionsDismissed.set(true);
        this.manualActiveIndex.set(-1);
        return;
      case 'Enter': {
        const idx = this.manualActiveIndex();
        if (idx < 0) return;
        event.preventDefault();
        if (idx < candidates.length) {
          this.selectManualCandidate(candidates[idx], input);
        } else if (this.manualShowAddNew()) {
          this.confirmAddNew(input);
        }
        return;
      }
    }
  }

  /**
   * Task 2 wrapper around Task 1's `addExisting`: also returns keyboard
   * focus to the search input (a DOM concern Task 1 explicitly left to this
   * task) and announces the addition for screen readers. Comparing
   * `rosterReviews` length before/after detects a no-op (a stale
   * double-click/tap on a candidate a first click already claimed, which
   * `addExisting` silently ignores) without re-deriving Task 1's own
   * eligibility check.
   */
  selectManualCandidate(candidate: PlayerCandidate, input: HTMLInputElement): void {
    const before = this.rosterReviews().length;
    this.addExisting(candidate.player.id);
    if (this.rosterReviews().length > before) {
      this.manualStatusMessage.set(
        $localize`:@@entry.manualAddedAnnounce:เพิ่ม ${candidate.player.name}:name: แล้ว`
      );
    }
    this.manualActiveIndex.set(-1);
    input.focus();
  }

  /**
   * Task 2 wrapper around Task 1's `addNew` — same reasoning as
   * `selectManualCandidate` above. Captures the typed name before calling
   * `addNew`, since a successful call clears `manualQuery`.
   */
  confirmAddNew(input: HTMLInputElement): void {
    const name = this.manualQuery().trim();
    const before = this.rosterReviews().length;
    this.addNew();
    if (this.rosterReviews().length > before) {
      this.manualStatusMessage.set($localize`:@@entry.manualAddedAnnounce:เพิ่ม ${name}:name: แล้ว`);
    }
    this.manualActiveIndex.set(-1);
    input.focus();
  }

  /**
   * Task 2 wrapper around Task 1's `removeManual` — adds the screen-reader
   * removal announcement.
   */
  removeManualRow(review: NameReview): void {
    const before = this.rosterReviews().length;
    const name = this.displayName(review);
    this.removeManual(review);
    if (this.rosterReviews().length < before) {
      this.manualStatusMessage.set($localize`:@@entry.manualRemovedAnnounce:ลบ ${name}:name: แล้ว`);
    }
  }

  async confirmRoster(): Promise<void> {
    if (this.isSubmitting() || !this.canConfirm()) return;

    this.confirmError.set(null);
    this.isSubmitting.set(true);
    this.creationIdempotencyKey ??= crypto.randomUUID();
    const anyLevel = [...this.rosterReviews(), ...this.waitlistReviews()].some((r) => r.level);
    try {
      const result = await firstValueFrom(
        this.rosterService.createSession({
          groupCode: this.groupCode,
          // A level choice carries the ladder revision the host picked it from, so a stale tab
          // cannot reapply a label a switch cleared even when the new ladder reuses its name.
          ...(anyLevel ? { expectedLadderRevision: this.ladder()?.revision } : {}),
          date: this.date(),
          venue: this.venue().trim() || null,
          courtCount: this.courtCount(),
          rawImportText: this.rawText(),
          idempotencyKey: this.creationIdempotencyKey,
          rosterReviews: this.rosterReviews(),
          waitlistReviews: this.waitlistReviews(),
        })
      );
      this.sessionCreated = true;
      this.clearUndo();
      this.drafts.clear(this.groupCode);
      await this.router.navigateByUrl(`/s/${result.code}`);
    } catch (err) {
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      if (code === 'LEVEL_LADDER_STALE' || code === 'LEVEL_UNKNOWN') {
        // Visible, and no session was made: reread the ladder and drop choices it no longer has.
        await this.loadLadder();
        const names = new Set(this.ladder()?.levels.map((l) => l.name) ?? []);
        const keep = (reviews: NameReview[]) => reviews.map((r) => (r.level && !names.has(r.level) ? { ...r, level: undefined } : r));
        this.rosterReviews.update(keep);
        this.waitlistReviews.update(keep);
        this.confirmError.set(levelsErrorMessage(code));
        return;
      }
      this.confirmError.set($localize`:@@entry.createSessionFailed:สร้างรอบไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
