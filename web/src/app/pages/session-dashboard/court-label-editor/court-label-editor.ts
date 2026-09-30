import { Component, computed, inject, input, signal } from '@angular/core';
import { labelForCourt } from '../../../core/court-label';
import { LiveSessionService } from '../../../core/live-session.service';
import { Icon } from '../../../shared/icon/icon';

/**
 * Renames one court for this session. Only the control — the host places the
 * heading. Allowed in every court and session state; a rejected save keeps
 * the draft open with the reason so the host can fix it in place.
 */
@Component({
  selector: 'app-court-label-editor',
  imports: [Icon],
  templateUrl: './court-label-editor.html',
  styleUrl: './court-label-editor.css',
})
export class CourtLabelEditor {
  readonly courtNumber = input.required<number>();
  readonly labels = input.required<readonly (string | null)[]>();

  private readonly liveSession = inject(LiveSessionService);

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly label = computed(() => labelForCourt(this.labels(), this.courtNumber()));
  protected readonly editLabel = computed(
    () => $localize`:@@courtLabel.edit:เปลี่ยนชื่อคอร์ท ${this.label()}:label:`
  );
  protected readonly fieldLabel = computed(
    () => $localize`:@@courtLabel.field:ชื่อคอร์ท ${this.courtNumber()}:number:`
  );

  protected open(): void {
    this.draft.set(this.labels()[this.courtNumber() - 1] ?? '');
    this.error.set(null);
    this.editing.set(true);
  }

  protected cancel(): void {
    this.editing.set(false);
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const result = await this.liveSession.setCourtLabel(this.courtNumber(), this.draft().trim());
    this.busy.set(false);
    if (result.ok) {
      this.editing.set(false);
    } else {
      this.error.set(result.error ?? $localize`:@@err.courtLabel:เปลี่ยนชื่อคอร์ทไม่สำเร็จ`);
    }
  }
}
