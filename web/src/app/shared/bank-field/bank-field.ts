import { Component, ElementRef, computed, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { searchBanks, type ThaiBank } from '../../core/thai-banks';

/**
 * A bank name field: the full list opens on focus or a tap (twelve big tap rows beat typing on a phone)
 * and narrows as the host types. Choosing a row fills the Thai name; anything else typed is kept
 * as free text, so a wallet or a small bank is never blocked. The value is always plain text, never
 * a code. The caller owns the label: it points at `inputId`.
 *
 * Same combobox behaviour as the player search (arrows, Enter, Escape, aria-activedescendant,
 * Enter ignored while a Thai IME composition commits). Options are never focused: focus stays in
 * the input and "active" is a class.
 */
@Component({
  selector: 'app-bank-field',
  templateUrl: './bank-field.html',
  styleUrl: './bank-field.css',
})
export class BankField {
  readonly value = input('');
  readonly inputId = input.required<string>();
  /** The caller's validation found this field wrong: marks the input aria-invalid. */
  readonly invalid = input(false);
  /** The id of the caller's error text for this field, read out with the input. */
  readonly describedBy = input<string | null>(null);
  readonly valueChange = output<string>();

  protected readonly query = linkedSignal(() => this.value());
  protected readonly open = signal(false);
  /** Off until the host types, so focusing a filled-in field still offers every bank. */
  private readonly filtering = signal(false);
  protected readonly activeIndex = signal(-1);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** Set only while focusWithoutOpening() runs, so the focus event it fires leaves the list shut. */
  private quietFocus = false;

  protected readonly matches = computed<ThaiBank[]>(() => searchBanks(this.filtering() ? this.query() : ''));
  protected readonly expanded = computed(() => this.open() && this.matches().length > 0);
  protected readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return this.expanded() && index >= 0 ? this.optionId(index) : null;
  });

  protected optionId(index: number): string {
    return `${this.inputId()}-option-${index}`;
  }

  /**
   * Focus for a caller that moves it, not the host (a refused save landing on the first invalid field): the
   * list stays shut so it never covers the error under the field. A tap or typing opens it as usual.
   */
  focusWithoutOpening(): void {
    this.quietFocus = true;
    try {
      this.field().nativeElement.focus();
    } finally {
      this.quietFocus = false;
    }
  }

  protected onFocus(): void {
    if (this.quietFocus) return;
    this.filtering.set(false);
    this.open.set(true);
  }

  /**
   * Focus does not fire again while the input stays focused, so after a pick or Escape a tap is the only
   * way back to the list on a phone (no arrow keys). A list that is already open is left as the host narrowed it.
   */
  protected onClick(): void {
    if (this.open()) return;
    this.filtering.set(false);
    this.open.set(true);
  }

  protected onBlur(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
  }

  protected onInput(text: string): void {
    this.query.set(text);
    this.filtering.set(true);
    this.open.set(true);
    this.activeIndex.set(-1);
    this.valueChange.emit(text);
  }

  protected select(bank: ThaiBank): void {
    this.query.set(bank.name);
    this.filtering.set(false);
    this.open.set(false);
    this.activeIndex.set(-1);
    this.valueChange.emit(bank.name);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const count = this.matches().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (count === 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.open.set(true);
        // From nothing highlighted, Up lands on the last row and Down on the first.
        this.activeIndex.update((i) => (i < 0 ? (step > 0 ? 0 : count - 1) : (i + step + count) % count));
        this.reveal();
        return;
      }
      case 'Escape':
        // A closed list lets Escape through to whatever is behind the field.
        if (!this.expanded()) return;
        event.preventDefault();
        this.open.set(false);
        this.activeIndex.set(-1);
        return;
      case 'Enter': {
        const index = this.activeIndex();
        if (!this.expanded() || index < 0) return;
        event.preventDefault();
        this.select(this.matches()[index]);
        return;
      }
    }
  }

  /** Keeps the highlighted row in view inside the scrolling list. */
  private reveal(): void {
    queueMicrotask(() => {
      const id = this.activeOptionId();
      if (id) document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' });
    });
  }
}
