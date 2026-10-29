import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { searchBanks, type ThaiBank } from '../../core/thai-banks';

/**
 * A bank name field: the full list opens on focus (twelve big tap rows beat typing on a phone)
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
  readonly valueChange = output<string>();

  protected readonly query = linkedSignal(() => this.value());
  protected readonly open = signal(false);
  /** Off until the host types, so focusing a filled-in field still offers every bank. */
  private readonly filtering = signal(false);
  protected readonly activeIndex = signal(-1);

  protected readonly matches = computed<ThaiBank[]>(() => searchBanks(this.filtering() ? this.query() : ''));
  protected readonly expanded = computed(() => this.open() && this.matches().length > 0);
  protected readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return this.expanded() && index >= 0 ? this.optionId(index) : null;
  });

  protected optionId(index: number): string {
    return `${this.inputId()}-option-${index}`;
  }

  protected onFocus(): void {
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
