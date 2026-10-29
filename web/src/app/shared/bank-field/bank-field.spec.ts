import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BankField } from './bank-field';

describe('BankField', () => {
  let fixture: ComponentFixture<BankField>;
  let emitted: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [BankField] }).compileComponents();
    fixture = TestBed.createComponent(BankField);
    emitted = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    fixture.componentRef.setInput('inputId', 'bank');
    fixture.detectChanges();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('input')!;
  const options = () => [...el().querySelectorAll<HTMLElement>('[role="option"]')];
  const names = () => options().map((o) => o.querySelector('.bank-name')?.textContent?.trim());

  async function type(text: string) {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function key(k: string, extra: Partial<KeyboardEventInit> = {}) {
    const event = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...extra });
    input().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  function focus() {
    input().dispatchEvent(new Event('focus'));
    fixture.detectChanges();
  }

  it('is a combobox that starts closed', () => {
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(options()).toHaveLength(0);
  });

  it('opens the full list of 12 on focus', () => {
    focus();
    expect(options()).toHaveLength(12);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    const list = el().querySelector('[role="listbox"]')!;
    expect(input().getAttribute('aria-controls')).toBe(list.id);
  });

  it('shows the full list on focus even when a bank is already filled in', async () => {
    fixture.componentRef.setInput('value', 'กสิกร');
    fixture.detectChanges();
    await fixture.whenStable();
    focus();
    expect(options()).toHaveLength(12);
  });

  it('narrows as the host types, and tapping a match emits the Thai name', async () => {
    focus();
    await type('kbank');
    expect(names()).toEqual(['กสิกร']);
    options()[0].click();
    fixture.detectChanges();
    expect(emitted.at(-1)).toBe('กสิกร');
    expect(input().value).toBe('กสิกร');
    expect(options()).toHaveLength(0);
  });

  it('keeps a bank that is not in the list as free text', async () => {
    focus();
    await type('Dime');
    expect(options()).toHaveLength(0);
    input().dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(emitted.at(-1)).toBe('Dime');
  });

  it('selects with the keyboard: arrow down then Enter', () => {
    focus();
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    key('ArrowDown');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(emitted.at(-1)).toBe('กรุงเทพ');
    expect(options()).toHaveLength(0);
  });

  it('arrow up from the top wraps to the last bank', () => {
    focus();
    key('ArrowUp');
    expect(options()[11].getAttribute('aria-selected')).toBe('true');
  });

  it('Enter with nothing highlighted leaves the typed text alone', async () => {
    focus();
    await type('kb');
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(emitted.at(-1)).toBe('kb');
  });

  it('Escape closes an open list, and a closed list lets Escape through', () => {
    focus();
    const first = key('Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(options()).toHaveLength(0);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    const second = key('Escape');
    expect(second.defaultPrevented).toBe(false);
  });

  it('arrow down reopens a list that Escape closed', () => {
    focus();
    key('Escape');
    key('ArrowDown');
    expect(options()).toHaveLength(12);
  });

  it('ignores Enter while a Thai IME composition is committing', () => {
    focus();
    key('ArrowDown');
    key('Enter', { isComposing: true });
    expect(emitted).toEqual([]);
  });

  it('closes the list on blur', () => {
    focus();
    input().dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(options()).toHaveLength(0);
  });

  it('caps the free text at 40 characters', () => {
    expect(input().getAttribute('maxlength')).toBe('40');
  });
});
