import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
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
/** Rosters up to this size show every chip without a filter field. */
const FILTER_THRESHOLD = 8;

@Component({
  selector: 'app-add-rule-dialog',
  imports: [],
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
  protected readonly filterLabel = $localize`:@@addRule.filterLabel:ค้นหาชื่อ`;
  protected readonly query = signal('');

  protected readonly showFilter = computed(() => this.players().length > FILTER_THRESHOLD);

  /** Chips narrowed by the typed name. A picked player stays pressed when the
   *  filter hides them — the summary line still names them. */
  protected readonly visiblePlayers = computed(() => {
    const q = this.query().trim().toLocaleLowerCase();
    if (!q) return this.players();
    return this.players().filter((p) => p.name.toLocaleLowerCase().includes(q));
  });

  /** Up to two player ids, in tap order. A rule is an unordered pair, so the
   *  order only decides which id the request lists first. */
  protected readonly picked = signal<readonly string[]>([]);
  protected readonly kind = signal<RuleKind>('must-pair');

  protected readonly pickedNames = computed(() =>
    this.picked()
      .map((id) => this.players().find((p) => p.id === id)?.name ?? '?')
      .join(' + ')
  );

  protected readonly canSubmit = computed(() => !this.saving() && this.picked().length === 2);

  open(): void {
    this.picked.set([]);
    this.query.set('');
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

  /** Tap to pick, tap again to drop. With two already picked, a third tap
   *  swaps out the later pick, so the host never has to clear first. */
  protected togglePlayer(id: string): void {
    const current = this.picked();
    // Picking clears the filter so the host can search for the second player.
    if (!current.includes(id)) this.query.set('');
    if (current.includes(id)) {
      this.picked.set(current.filter((x) => x !== id));
    } else if (current.length < 2) {
      this.picked.set([...current, id]);
    } else {
      this.picked.set([current[0], id]);
    }
  }

  protected submit(): void {
    if (!this.canSubmit()) return;
    const [playerAId, playerBId] = this.picked();
    this.add.emit({ playerAId, playerBId, kind: this.kind() });
  }
}
