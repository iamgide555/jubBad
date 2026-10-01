import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  RULE_KINDS,
  RULE_KIND_HINTS,
  type CreatePairRuleRequest,
  type RuleKind,
} from '../../core/pair-rule.model';

/**
 * Add a pair rule from the live dashboard. Follows AddWalkInDialog's shape:
 * HTTP-free, only emits the rule the host chose — the dashboard makes the
 * POST and reports back via `saving`/`error`. The rule is a normal group
 * rule (it persists past tonight); the dialog says so, since the host is
 * standing in a session when they add it.
 */
@Component({
  selector: 'app-add-rule-dialog',
  imports: [FormsModule],
  templateUrl: './add-rule-dialog.html',
  styleUrl: './add-rule-dialog.css',
})
export class AddRuleDialog {
  /** Tonight's roster — the people a host can name mid-session. */
  readonly players = input<readonly { id: string; name: string }[]>([]);
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly add = output<CreatePairRuleRequest>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly ruleKinds = RULE_KINDS;
  protected readonly kindHints = RULE_KIND_HINTS;
  protected readonly isOpen = signal(false);
  protected readonly playerA = signal('');
  protected readonly playerB = signal('');
  protected readonly kind = signal<RuleKind>('must-pair');

  protected readonly partnerOptions = computed(() =>
    this.players().filter((p) => p.id !== this.playerA())
  );

  protected readonly canSubmit = computed(
    () =>
      !this.saving() &&
      this.playerA() !== '' &&
      this.playerB() !== '' &&
      this.playerA() !== this.playerB()
  );

  open(): void {
    this.playerA.set('');
    this.playerB.set('');
    this.kind.set('must-pair');
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

  protected setPlayerA(id: string): void {
    this.playerA.set(id);
    if (this.playerB() === id) this.playerB.set('');
  }

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.add.emit({ playerAId: this.playerA(), playerBId: this.playerB(), kind: this.kind() });
  }
}
