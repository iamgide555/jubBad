import { Component, ElementRef, computed, input, model, signal, viewChild } from '@angular/core';

/**
 * A password input for the sign-up and link forms: the length rule shown before anything is submitted, and a
 * show/hide toggle. With no email on file to recover through, a typo in a new password is the commonest way to lock
 * oneself out, so the field helps the person see what they typed.
 */
@Component({
  selector: 'app-password-field',
  templateUrl: './password-field.html',
  styleUrl: './password-field.css',
})
export class PasswordField {
  readonly fieldId = input.required<string>();
  readonly autocomplete = input<'new-password' | 'current-password'>('new-password');
  readonly minLength = input<number | null>(null);
  /** The rule, shown under the field (e.g. "at least 8 characters"). */
  readonly hint = input<string | null>(null);
  readonly invalid = input(false);
  /** The id of the form's error line, so a screen reader reads it with the field. */
  readonly describedBy = input<string | null>(null);
  readonly value = model('');

  protected readonly shown = signal(false);
  protected readonly hintId = computed(() => `${this.fieldId()}-hint`);
  protected readonly describedIds = computed(() => {
    const ids = [this.hint() ? this.hintId() : null, this.describedBy()].filter((id): id is string => id !== null);
    return ids.length > 0 ? ids.join(' ') : null;
  });
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('field');

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
