import { Component, ElementRef, effect, input, output, signal, untracked, viewChild } from '@angular/core';

export interface ResultCorrection {
  winner: 'A' | 'B' | null;
  scoreA: number | null;
  scoreB: number | null;
}

/**
 * Corrects a finished game's winner and score. HTTP-free like the shuttle
 * sheet: it only emits what the host settled on and the summary page makes the
 * write, so a stale or refused correction never looks saved. "No result" is a
 * legitimate answer (an abandoned game), same as at finish.
 */
@Component({
  selector: 'app-result-correction-dialog',
  imports: [],
  templateUrl: './result-correction-dialog.html',
  styleUrl: './result-correction-dialog.css',
})
export class ResultCorrectionDialog {
  /** e.g. "คอร์ท 2 · แมตช์ 3" — which game is being corrected. */
  readonly rowLabel = input('');
  readonly teamA = input<readonly string[]>([]);
  readonly teamB = input<readonly string[]>([]);
  /** The game's recorded result, read when the sheet opens. */
  readonly initial = input<ResultCorrection>({ winner: null, scoreA: null, scoreB: null });
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly save = output<ResultCorrection>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  protected readonly scoreA = signal('');
  protected readonly scoreB = signal('');
  protected readonly localError = signal<string | null>(null);

  constructor() {
    // The parent picks the game and calls open() in the same tick, before this
    // component's inputs have been refreshed, so open() alone reads the previous
    // game's score (blank on the first open). Syncing whenever the input changes
    // is what puts the right numbers in the boxes.
    effect(() => {
      const init = this.initial();
      untracked(() => this.applyInitial(init));
    });
  }

  private applyInitial(init: ResultCorrection): void {
    this.scoreA.set(init.scoreA === null ? '' : String(init.scoreA));
    this.scoreB.set(init.scoreB === null ? '' : String(init.scoreB));
    this.localError.set(null);
  }

  open(): void {
    // Also resets edits left over from a cancelled attempt at the same game.
    this.applyInitial(this.initial());
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  close(): void {
    this.isOpen.set(false);
    this.dialogEl().nativeElement.close();
  }

  protected onDialogClose(): void {
    this.isOpen.set(false);
  }

  protected onCancelAttempt(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  /** In TS because the team names are dynamic inside the sentence; same id and wording as the live court's winner button. */
  protected wonLabel(names: readonly string[]): string {
    const team = names.join(' & ');
    return $localize`:@@court.wonBy:${team}:team: ชนะ`;
  }

  /**
   * Tapping a winner is the save: the winner plus whatever scores are filled in.
   * `null` is "no result" (an abandoned game): it has no score by definition, so
   * it clears both rather than making the host empty the boxes first.
   */
  protected choose(winner: 'A' | 'B' | null): void {
    if (this.saving()) return;
    if (winner === null) {
      this.localError.set(null);
      this.save.emit({ winner: null, scoreA: null, scoreB: null });
      return;
    }
    const parse = (raw: string): number | null | 'bad' => {
      const t = raw.trim();
      if (t === '') return null;
      const n = Number(t);
      return Number.isInteger(n) && n >= 0 ? n : 'bad';
    };
    const a = parse(this.scoreA());
    const b = parse(this.scoreB());
    if (a === 'bad' || b === 'bad') {
      this.localError.set($localize`:@@resultFix.badScore:คะแนนต้องเป็นจำนวนเต็มตั้งแต่ 0`);
      return;
    }
    if ((a === null) !== (b === null)) {
      this.localError.set($localize`:@@resultFix.incompleteScore:ใส่คะแนนให้ครบทั้งสองทีม หรือเว้นว่างทั้งคู่`);
      return;
    }
    if (a !== null && b !== null && ((winner === 'A' && a <= b) || (winner === 'B' && b <= a))) {
      this.localError.set($localize`:@@resultFix.mismatch:คะแนนไม่ตรงกับทีมที่ชนะ`);
      return;
    }
    this.localError.set(null);
    this.save.emit({ winner, scoreA: a, scoreB: b });
  }
}
