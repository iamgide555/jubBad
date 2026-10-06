import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';

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
  protected readonly winner = signal<'A' | 'B' | null>(null);
  protected readonly scoreA = signal('');
  protected readonly scoreB = signal('');
  protected readonly localError = signal<string | null>(null);

  protected readonly teamAName = computed(() => this.teamA().join(' + '));
  protected readonly teamBName = computed(() => this.teamB().join(' + '));

  open(): void {
    const init = this.initial();
    this.winner.set(init.winner);
    this.scoreA.set(init.scoreA === null ? '' : String(init.scoreA));
    this.scoreB.set(init.scoreB === null ? '' : String(init.scoreB));
    this.localError.set(null);
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

  protected submit(): void {
    if (this.saving()) return;
    const parse = (raw: string): number | null | 'bad' => {
      const t = raw.trim();
      if (t === '') return null;
      const n = Number(t);
      return Number.isInteger(n) && n >= 0 ? n : 'bad';
    };
    const a = parse(this.scoreA());
    const b = parse(this.scoreB());
    const winner = this.winner();
    if (a === 'bad' || b === 'bad') {
      this.localError.set($localize`:@@resultFix.badScore:คะแนนต้องเป็นจำนวนเต็มตั้งแต่ 0`);
      return;
    }
    if ((a === null) !== (b === null)) {
      this.localError.set($localize`:@@resultFix.incompleteScore:ใส่คะแนนให้ครบทั้งสองทีม หรือเว้นว่างทั้งคู่`);
      return;
    }
    if (a !== null && b !== null) {
      if (winner === null) {
        this.localError.set($localize`:@@resultFix.winnerNeeded:เลือกทีมที่ชนะเมื่อมีคะแนน`);
        return;
      }
      if ((winner === 'A' && a <= b) || (winner === 'B' && b <= a)) {
        this.localError.set($localize`:@@resultFix.mismatch:คะแนนไม่ตรงกับทีมที่ชนะ`);
        return;
      }
    }
    this.localError.set(null);
    this.save.emit({ winner, scoreA: a, scoreB: b });
  }
}
