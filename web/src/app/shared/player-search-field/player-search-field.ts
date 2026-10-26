import { Component, ElementRef, computed, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import type { AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Player } from '../../../../../engines/fuzzy-match.ts';
import { Icon } from '../icon/icon';
import {
  exactPlayerMatch,
  literalKey,
  searchCandidates,
  type PlayerCandidate,
} from '../../core/roster-review';

/**
 * A search-or-type field for picking one player: ranked existing players first, then "add as new".
 * Used to rename a row on the roster review. Pure UI: it decides nothing about the roster. The
 * caller says who is already taken (`claimedIds`) and which names are already drafted as new
 * (`drafts`), and gets back either an existing player's id or a new trimmed name.
 *
 * Same behaviour as the manual-add box on the review screen (ranked candidates, a trailing
 * "add as new", arrows/Enter/Escape, a guard so committing a Thai IME composition never acts as
 * Enter, aria-activedescendant). A fuzzy hit is only ever a candidate to tap, never auto-chosen.
 */
@Component({
  selector: 'app-player-search-field',
  imports: [FormsModule, Icon],
  templateUrl: './player-search-field.html',
  styleUrl: './player-search-field.css',
})
export class PlayerSearchField implements AfterViewInit {
  readonly players = input.required<Player[]>();
  /** Players another row already uses. The caller leaves out the row being renamed. */
  readonly claimedIds = input.required<ReadonlySet<string>>();
  /** Literal keys (see `literalKey`) of names already staged as new players on other rows. */
  readonly drafts = input<ReadonlySet<string>>(new Set());
  readonly initialText = input('');
  readonly idPrefix = input('rename');
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly disabled = input(false);

  readonly pickExisting = output<string>();
  readonly pickNew = output<string>();
  /** Escape on a closed list, or the field losing focus. */
  readonly cancel = output<void>();

  private readonly inputRef = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected readonly query = linkedSignal(() => this.initialText());
  protected readonly error = signal<string | null>(null);
  protected readonly activeIndex = signal(-1);
  protected readonly dismissed = signal(false);

  protected readonly candidates = computed<PlayerCandidate[]>(() =>
    searchCandidates(this.query(), this.players(), this.claimedIds())
  );

  /** The player whose name or alias is exactly what is typed, claimed or not. */
  private readonly exact = computed(() => exactPlayerMatch(this.query().trim(), this.players()));

  protected readonly alreadySelectedName = computed(() => {
    const player = this.exact();
    return player && this.claimedIds().has(player.id) ? player.name : null;
  });

  /** Add-as-new only for a name that matches nobody: an exact match is offered, or reported as taken. */
  protected readonly showAddNew = computed(() => this.query().trim().length > 0 && this.exact() === null);

  protected readonly showSuggestions = computed(
    () => !this.disabled() && !this.dismissed() && (this.candidates().length > 0 || this.showAddNew())
  );

  protected readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return index >= 0 ? `${this.idPrefix()}-option-${index}` : null;
  });

  ngAfterViewInit(): void {
    this.inputRef().nativeElement.focus();
  }

  protected onQueryChange(value: string): void {
    this.query.set(value);
    this.error.set(null);
    this.activeIndex.set(-1);
    this.dismissed.set(false);
  }

  protected onFocus(): void {
    this.dismissed.set(false);
  }

  protected onBlur(): void {
    this.cancel.emit();
  }

  protected selectCandidate(candidate: PlayerCandidate): void {
    if (this.disabled() || this.claimedIds().has(candidate.player.id)) return;
    this.activeIndex.set(-1);
    this.pickExisting.emit(candidate.player.id);
  }

  protected confirmAddNew(): void {
    if (this.disabled()) return;
    this.error.set(null);
    const name = this.query().trim();
    if (!name) {
      this.error.set($localize`:@@entry.manualAddEmpty:กรุณาพิมพ์ชื่อก่อน`);
      return;
    }
    if (this.exact()) {
      this.error.set($localize`:@@entry.manualAddExactExists:มีผู้เล่นชื่อนี้อยู่แล้ว กรุณาเลือกจากรายการ`);
      return;
    }
    if (this.drafts().has(literalKey(name))) {
      this.error.set($localize`:@@entry.manualAddDuplicate:เพิ่มชื่อนี้ไปแล้ว`);
      return;
    }
    this.activeIndex.set(-1);
    this.pickNew.emit(name);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || this.disabled()) return;
    const candidates = this.candidates();
    const optionCount = candidates.length + (this.showAddNew() ? 1 : 0);
    switch (event.key) {
      case 'ArrowDown':
        if (optionCount === 0) return;
        event.preventDefault();
        this.dismissed.set(false);
        this.activeIndex.update((i) => (i + 1) % optionCount);
        return;
      case 'ArrowUp':
        if (optionCount === 0) return;
        event.preventDefault();
        this.dismissed.set(false);
        this.activeIndex.update((i) => (i - 1 + optionCount) % optionCount);
        return;
      case 'Escape':
        event.preventDefault();
        // The first Escape closes an open list, the next one gives the rename up.
        if (this.showSuggestions()) {
          this.dismissed.set(true);
          this.activeIndex.set(-1);
        } else {
          this.cancel.emit();
        }
        return;
      case 'Enter': {
        const index = this.activeIndex();
        if (index < 0) return;
        event.preventDefault();
        if (index < candidates.length) this.selectCandidate(candidates[index]);
        else if (this.showAddNew()) this.confirmAddNew();
        return;
      }
    }
  }
}
