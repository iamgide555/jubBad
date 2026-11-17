import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PasswordField } from './password-field';

@Component({
  imports: [PasswordField],
  template: `<app-password-field
    fieldId="pw"
    autocomplete="new-password"
    [minLength]="8"
    [hint]="hint()"
    [invalid]="invalid()"
    describedBy="form-error"
    [(value)]="value"
  />`,
})
class Host {
  readonly value = signal('');
  readonly hint = signal<string | null>('อย่างน้อย 8 ตัวอักษร');
  readonly invalid = signal(false);
}

describe('PasswordField', () => {
  let fixture: ComponentFixture<Host>;
  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('#pw')!;
  const toggle = () => el().querySelector<HTMLButtonElement>('[data-show-password]')!;

  beforeEach(() => {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('is a password input with the id, autocomplete and length rule it was given', () => {
    expect(input().type).toBe('password');
    expect(input().getAttribute('autocomplete')).toBe('new-password');
    expect(input().getAttribute('minlength')).toBe('8');
  });

  it('shows the length hint before anything is submitted, and the input points at it', () => {
    const hint = el().querySelector<HTMLElement>('[data-password-hint]')!;
    expect(hint.textContent).toContain('8');
    expect(input().getAttribute('aria-describedby')).toContain(hint.id);
  });

  it('has no hint element when none is given, and still points at the form error', () => {
    fixture.componentInstance.hint.set(null);
    fixture.detectChanges();
    expect(el().querySelector('[data-password-hint]')).toBeNull();
    expect(input().getAttribute('aria-describedby')).toBe('form-error');
  });

  it('writes what is typed back to the model', () => {
    input().value = 'secret123';
    input().dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.value()).toBe('secret123');
  });

  it('shows what the model holds', () => {
    fixture.componentInstance.value.set('from-outside');
    fixture.detectChanges();
    expect(input().value).toBe('from-outside');
  });

  it('shows and hides the password with a button that says which it is', () => {
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    toggle().click();
    fixture.detectChanges();
    expect(input().type).toBe('text');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    toggle().click();
    fixture.detectChanges();
    expect(input().type).toBe('password');
  });

  it('marks itself invalid for screen readers', () => {
    fixture.componentInstance.invalid.set(true);
    fixture.detectChanges();
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the toggle a 44px target and out of the form submit', () => {
    expect(toggle().type).toBe('button');
  });
});
