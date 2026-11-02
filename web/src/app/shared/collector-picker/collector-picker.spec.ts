import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import type { LineAccountRow } from '../../core/line-accounts.service';
import { CollectorPicker } from './collector-picker';

const URL = `${environment.apiBaseUrl}/groups/g1/line/accounts`;

const row = (id: string, over: Partial<LineAccountRow> = {}): LineAccountRow => ({
  id,
  displayName: `line-${id}`,
  pictureUrl: null,
  source: 'roster',
  firstSeenAt: '2026-10-01T00:00:00Z',
  lastSeenAt: '2026-10-01T00:00:00Z',
  player: { id: `p-${id}`, name: `Player ${id}`, linkedBy: 'host' },
  ...over,
});

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

describe('CollectorPicker', () => {
  let fixture: ComponentFixture<CollectorPicker>;
  let http: HttpTestingController;
  let chosen: (string | null)[];

  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el().querySelector<T>(s);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const expand = async () => {
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    if (trigger.getAttribute('aria-expanded') === 'false') trigger.click();
    await settle();
  };

  async function open(
    rows: LineAccountRow[],
    value: string | null = null,
    disabled = false,
    more: { lapsed?: boolean; optional?: boolean } = {}
  ) {
    await TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CollectorPicker);
    fixture.componentRef.setInput('groupCode', 'g1');
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('disabled', disabled);
    for (const [name, v] of Object.entries(more)) fixture.componentRef.setInput(name, v);
    chosen = [];
    fixture.componentInstance.chosen.subscribe((v) => chosen.push(v));
    fixture.detectChanges();
    http.expectOne(URL).flush(rows);
    await settle();
  }

  afterEach(() => http.verify());

  it('starts as one collapsed field with the selected avatar and name', async () => {
    await open([row('a'), row('c', { pictureUrl: 'https://profile.line-scdn.net/c' })], 'p-c');
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]');
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain('Player c');
    expect(trigger!.textContent).not.toContain('Player a');
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    expect(q<HTMLElement>('[data-collector-options]')!.hidden).toBe(true);
    expect(trigger!.querySelector('img')!.getAttribute('src')).toBe('https://profile.line-scdn.net/c');
    expect(trigger!.querySelector('img')!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('opens avatar options on demand and closes before confirmation; cancel preserves selected field', async () => {
    await open([row('a'), row('c', { pictureUrl: 'https://profile.line-scdn.net/c' })], 'p-a');
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    expect(trigger).not.toBeNull();
    trigger.click();
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(q<HTMLElement>('[data-collector-options]')!.hidden).toBe(false);
    expect(q('[data-collector-option="p-c"] img')).not.toBeNull();
    await expand();
    q('[data-collector-option="p-c"]')!.click();
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(q('[data-collector-dialog] app-line-avatar')).not.toBeNull();
    expect(chosen).toEqual([]);
    q('[data-collector-cancel]')!.click();
    await settle();
    expect(trigger.textContent).toContain('Player a');
    expect(document.activeElement).toBe(trigger);
  });

  it('supports arrow keys, Home/End and Escape without changing the saved value', async () => {
    await open([row('a'), row('c')], 'p-a');
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    expect(trigger).not.toBeNull();
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await settle();
    expect(document.activeElement).toBe(q('[data-collector-option="p-a"]'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await settle();
    expect(document.activeElement).toBe(q('[data-collector-option="p-c"]'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await settle();
    expect(document.activeElement).toBe(q('[data-collector-option="none"]'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(chosen).toEqual([]);
  });

  it('closes on outside click without opening confirmation or changing selection', async () => {
    await open([row('a')], 'p-a');
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    expect(trigger).not.toBeNull();
    trigger.click();
    await settle();
    document.body.click();
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(q<HTMLDialogElement>('dialog')!.open).toBe(false);
    expect(chosen).toEqual([]);
  });

  it('opens above the field when the phone viewport has insufficient room below', async () => {
    await open([row('a')]);
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, window.innerHeight - 100, 300, 50));
    await expand();
    expect(q('[data-collector-options]')!.classList.contains('above')).toBe(true);
    expect(parseFloat(q<HTMLElement>('[data-collector-options]')!.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight / 2);
  });

  it('lists only accounts linked to a player, with the player name and the LINE name', async () => {
    await open([row('a'), row('b', { player: null }), row('c', { displayName: 'Cee line' })]);
    const options = el().querySelectorAll('[data-collector-option]');
    // nobody + two linked rows; the unlinked account is not offered.
    expect(options).toHaveLength(3);
    expect(q('[data-collector-option="p-a"]')!.textContent).toContain('Player a');
    expect(q('[data-collector-option="p-a"]')!.textContent).toContain('line-a');
    expect(q('[data-collector-option="p-c"]')!.textContent).toContain('Cee line');
    expect(q('[data-collector-option="p-b"]')).toBeNull();
    expect(q('[data-collector-option="none"]')!.textContent).toContain('ไม่มี');
  });

  it('shows the LINE picture with no referrer', async () => {
    await open([row('a', { pictureUrl: 'https://profile.line-scdn.net/x' })]);
    const img = q<HTMLImageElement>('[data-collector-option="p-a"] img')!;
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('says so when nobody has a linked LINE account', async () => {
    await open([row('b', { player: null })]);
    expect(q('[data-collector-empty]')!.textContent).toContain('ยังไม่มีผู้เล่นที่ผูก LINE');
    expect(q('[data-collector-option]')).toBeNull();
  });

  it('marks the current collector as pressed', async () => {
    await open([row('a'), row('c')], 'p-c');
    expect(q('[data-collector-option="p-c"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-collector-option="p-a"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-collector-option="none"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-collector-stale]')).toBeNull();
  });

  it('shows a value whose LINE was unlinked as nobody, with a note', async () => {
    await open([row('a')], 'p-gone');
    expect(q('[data-collector-option="none"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-collector-stale]')!.textContent).toContain('คนที่เลือกไว้ไม่ได้ผูก LINE แล้ว');
  });

  it('asks before emitting, naming the player and the LINE name', async () => {
    await open([row('a')]);
    await expand();
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    expect(chosen).toEqual([]);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(true);
    expect(q('[data-collector-text]')!.textContent).toContain('ให้ Player a (LINE: line-a) จัดการการชำระเงินใน LINE ได้?');
  });

  it('emits nothing when the dialog is cancelled', async () => {
    await open([row('a')]);
    await expand();
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    q('[data-collector-cancel]')!.click();
    await settle();
    expect(chosen).toEqual([]);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('emits the player id once confirmed', async () => {
    await open([row('a')]);
    await expand();
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    q('[data-collector-confirm]')!.click();
    await settle();
    expect(chosen).toEqual(['p-a']);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('asks the clearing question for nobody and emits null', async () => {
    await open([row('a')], 'p-a');
    await expand();
    q('[data-collector-option="none"]')!.click();
    await settle();
    expect(q('[data-collector-text]')!.textContent).toContain('ไม่ให้ใครจัดการการชำระเงินใน LINE?');
    expect(chosen).toEqual([]);
    q('[data-collector-confirm]')!.click();
    await settle();
    expect(chosen).toEqual([null]);
  });

  it('does not ask again for the option already chosen', async () => {
    await open([row('a')], 'p-a');
    await expand();
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
    expect(chosen).toEqual([]);
  });

  it('refuses taps while disabled, but keeps the field focusable (aria-disabled, not disabled)', async () => {
    await open([row('a')], null, true);
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    trigger.focus();
    trigger.click();
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(chosen).toEqual([]);
  });

  it('turns aria-disabled off again once enabled', async () => {
    await open([row('a')], null, true);
    fixture.componentRef.setInput('disabled', false);
    await settle();
    expect(q('[data-collector-trigger]')!.hasAttribute('aria-disabled')).toBe(false);
  });

  it('closes the open menu when saving starts, preserves field focus and stays closed when enabled again', async () => {
    await open([row('a')]);
    await expand();
    fixture.componentRef.setInput('disabled', true);
    await settle();
    const trigger = q<HTMLButtonElement>('[data-collector-trigger]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    fixture.componentRef.setInput('disabled', false);
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('names the dialog by its question', async () => {
    await open([row('a')]);
    await expand();
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    const dialog = q<HTMLDialogElement>('dialog')!;
    const id = dialog.getAttribute('aria-labelledby');
    expect(id).toBeTruthy();
    expect(el().querySelector(`#${id}`)).toBe(q('[data-collector-text]'));
  });

  it('can clear a stale value when nobody is linked any more', async () => {
    await open([row('b', { player: null })], 'p-gone');
    expect(q('[data-collector-empty]')).not.toBeNull();
    expect(q('[data-collector-stale]')).not.toBeNull();
    expect(q('[data-collector-option="none"]')!.getAttribute('aria-pressed')).toBe('true');
    await expand();
    q('[data-collector-option="none"]')!.click();
    await settle();
    expect(q('[data-collector-text]')!.textContent).toContain('ไม่ให้ใครจัดการการชำระเงินใน LINE?');
    q('[data-collector-confirm]')!.click();
    await settle();
    expect(chosen).toEqual([null]);
  });

  it('shows a pick the server reports lapsed as nobody with the note, and lets it be cleared', async () => {
    await open([row('a')], null, false, { lapsed: true });
    expect(q('[data-collector-option="none"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-collector-option="p-a"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-collector-stale]')!.textContent).toContain('คนที่เลือกไว้ไม่ได้ผูก LINE แล้ว');
    await expand();
    q('[data-collector-option="none"]')!.click();
    await settle();
    q('[data-collector-confirm]')!.click();
    await settle();
    expect(chosen).toEqual([null]);
  });

  it('offers nobody for a lapsed pick even when nobody is linked any more', async () => {
    await open([], null, false, { lapsed: true });
    expect(q('[data-collector-option="none"]')).not.toBeNull();
    expect(q('[data-collector-stale]')).not.toBeNull();
  });

  describe('optional', () => {
    it('renders nothing when nobody is linked and nothing is set', async () => {
      await open([row('b', { player: null })], null, false, { optional: true });
      expect(q('[data-collector-picker]')).toBeNull();
      expect(el().hidden).toBe(true);
    });

    it('still renders when there is someone to pick', async () => {
      await open([row('a')], null, false, { optional: true });
      expect(q('[data-collector-picker]')).not.toBeNull();
      expect(el().hidden).toBe(false);
    });

    it('still renders a stale value to clear', async () => {
      await open([], 'p-gone', false, { optional: true });
      expect(q('[data-collector-option="none"]')).not.toBeNull();
      expect(el().hidden).toBe(false);
    });

    it('still renders when the list cannot be read', async () => {
      await TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
      http = TestBed.inject(HttpTestingController);
      fixture = TestBed.createComponent(CollectorPicker);
      fixture.componentRef.setInput('groupCode', 'g1');
      fixture.componentRef.setInput('optional', true);
      fixture.detectChanges();
      http.expectOne(URL).flush('x', { status: 500, statusText: 'x' });
      await settle();
      expect(q('[data-collector-load-failed]')).not.toBeNull();
      expect(el().hidden).toBe(false);
    });
  });

  it('offers a retry when the list cannot be read', async () => {
    await TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CollectorPicker);
    fixture.componentRef.setInput('groupCode', 'g1');
    fixture.componentRef.setInput('value', null);
    fixture.detectChanges();
    http.expectOne(URL).flush('x', { status: 500, statusText: 'x' });
    await settle();
    expect(q('[data-collector-load-failed]')).not.toBeNull();
    q('[data-collector-retry]')!.click();
    await settle();
    http.expectOne(URL).flush([row('a')]);
    await settle();
    expect(q('[data-collector-option="p-a"]')).not.toBeNull();
  });
});
