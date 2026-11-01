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

  async function open(rows: LineAccountRow[], value: string | null = null, disabled = false) {
    await TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CollectorPicker);
    fixture.componentRef.setInput('groupCode', 'g1');
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('disabled', disabled);
    chosen = [];
    fixture.componentInstance.chosen.subscribe((v) => chosen.push(v));
    fixture.detectChanges();
    http.expectOne(URL).flush(rows);
    await settle();
  }

  afterEach(() => http.verify());

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
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    expect(chosen).toEqual([]);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(true);
    expect(q('[data-collector-text]')!.textContent).toContain('ให้ Player a (LINE: line-a) จัดการการชำระเงินใน LINE ได้?');
  });

  it('emits nothing when the dialog is cancelled', async () => {
    await open([row('a')]);
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    q('[data-collector-cancel]')!.click();
    await settle();
    expect(chosen).toEqual([]);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('emits the player id once confirmed', async () => {
    await open([row('a')]);
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    q('[data-collector-confirm]')!.click();
    await settle();
    expect(chosen).toEqual(['p-a']);
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('asks the clearing question for nobody and emits null', async () => {
    await open([row('a')], 'p-a');
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
    q('[data-collector-option="p-a"]')!.click();
    await settle();
    expect(q<HTMLDialogElement>('dialog')!.hasAttribute('open')).toBe(false);
    expect(chosen).toEqual([]);
  });

  it('refuses taps while disabled', async () => {
    await open([row('a')], null, true);
    expect(q<HTMLButtonElement>('[data-collector-option="p-a"]')!.disabled).toBe(true);
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
