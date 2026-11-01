import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LineAccountRow } from '../../core/line-accounts.service';
import { LineAccountPicker } from './line-account-picker';

// jsdom implements no showModal()/close() on <dialog>. Guarded so a future jsdom that implements them takes over.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

const account = (id: string, displayName: string | null): LineAccountRow => ({
  id,
  displayName,
  pictureUrl: null,
  source: 'roster',
  firstSeenAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-20T10:00:00.000Z',
  player: null,
});

@Component({
  imports: [LineAccountPicker],
  template: `<app-line-account-picker #picker [accounts]="accounts()" (picked)="pickedIds.push($event)" (closed)="closedCount = closedCount + 1" />`,
})
class Host {
  accounts = signal<LineAccountRow[]>([]);
  pickedIds: string[] = [];
  closedCount = 0;
}

describe('LineAccountPicker', () => {
  function mount(accounts: LineAccountRow[]) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.accounts.set(accounts);
    fixture.detectChanges();
    const picker = fixture.debugElement.children[0].componentInstance as LineAccountPicker;
    picker.open();
    fixture.detectChanges();
    return fixture;
  }
  const el = (f: { nativeElement: unknown }) => f.nativeElement as HTMLElement;
  const rows = (f: { nativeElement: unknown }) => [...el(f).querySelectorAll<HTMLElement>('[data-account]')];

  it('lists each account with its name and when it was last seen', () => {
    const f = mount([account('a1', 'Tam'), account('a2', 'Mod')]);
    expect(rows(f).map((r) => r.querySelector('.name')!.textContent!.trim())).toEqual(['Tam', 'Mod']);
    expect(rows(f)[0].querySelector('.seen')!.textContent!.trim()).not.toBe('');
    expect(rows(f)[0].querySelector('app-line-avatar')).not.toBeNull();
  });

  it('filters by name', () => {
    const f = mount([account('a1', 'Tam'), account('a2', 'Mod'), account('a3', 'tamarind')]);
    const input = el(f).querySelector<HTMLInputElement>('input.account-filter')!;
    input.value = 'TAM';
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(rows(f).map((r) => r.getAttribute('data-account'))).toEqual(['a1', 'a3']);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(rows(f)).toEqual([]);
    expect(el(f).querySelector('[data-no-match]')).not.toBeNull();
  });

  it('shows an empty message when no unlinked accounts exist', () => {
    const f = mount([]);
    expect(rows(f)).toEqual([]);
    expect(el(f).querySelector('[data-empty]')!.textContent).toContain('ยังไม่มีบัญชี LINE ที่ยังไม่ได้ผูก');
    expect(el(f).querySelector('input.account-filter')).toBeNull();
  });

  it('emits the account id on a tap and closes', () => {
    const f = mount([account('a1', 'Tam'), account('a2', 'Mod')]);
    rows(f)[1].click();
    f.detectChanges();
    expect(f.componentInstance.pickedIds).toEqual(['a2']);
    expect(el(f).querySelector('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('names an account with no display name as unknown', () => {
    const f = mount([account('a1', null)]);
    expect(rows(f)[0].querySelector('.name')!.textContent).toContain('ไม่ทราบชื่อ');
  });

  it('tells the caller when it is dismissed', () => {
    const f = mount([account('a1', 'Tam')]);
    el(f).querySelector<HTMLButtonElement>('[data-close]')!.click();
    f.detectChanges();
    expect(f.componentInstance.closedCount).toBe(1);
  });
});
