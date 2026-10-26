import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PlayerSearchField } from './player-search-field';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

const PLAYERS: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เกียร์', aliases: [] },
  { id: 'p3', name: 'มด', aliases: [] },
  { id: 'p4', name: 'มะนาว', aliases: [] },
];

describe('PlayerSearchField', () => {
  let fixture: ComponentFixture<PlayerSearchField>;
  let picked: string[];
  let pickedNew: string[];
  let cancels: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlayerSearchField] }).compileComponents();
    fixture = TestBed.createComponent(PlayerSearchField);
    picked = [];
    pickedNew = [];
    cancels = 0;
    fixture.componentInstance.pickExisting.subscribe((id) => picked.push(id));
    fixture.componentInstance.pickNew.subscribe((name) => pickedNew.push(name));
    fixture.componentInstance.cancel.subscribe(() => cancels++);
    fixture.componentRef.setInput('players', PLAYERS);
    fixture.componentRef.setInput('claimedIds', new Set<string>());
    fixture.componentRef.setInput('drafts', new Set<string>());
    fixture.componentRef.setInput('label', 'ค้นหาชื่อผู้เล่น หรือพิมพ์ชื่อใหม่');
    fixture.componentRef.setInput('placeholder', 'ค้นหาชื่อผู้เล่น หรือพิมพ์ชื่อใหม่');
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('input')!;
  const options = () => [...el().querySelectorAll<HTMLElement>('[role="option"]')];

  async function type(text: string) {
    const field = input();
    field.value = text;
    field.dispatchEvent(new Event('input'));
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

  it('shows ranked candidates as the host types', async () => {
    fixture.detectChanges();
    await type('ม');
    expect(options().map((o) => o.textContent?.trim())).toEqual(expect.arrayContaining(['มด', 'มะนาว']));
    expect(input().getAttribute('role')).toBe('combobox');
  });

  it('picks the highlighted candidate with the arrow keys and Enter', async () => {
    fixture.detectChanges();
    await type('เกียร์');
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('rename-option-0');
    key('Enter');
    expect(picked).toEqual(['p2']);
  });

  it('picks a candidate that is tapped', async () => {
    fixture.detectChanges();
    await type('มด');
    options()[0].click();
    expect(picked).toEqual(['p3']);
  });

  it('offers add-as-new for a name that matches nobody and emits the trimmed text', async () => {
    fixture.detectChanges();
    await type('  คนใหม่  ');
    const add = el().querySelector<HTMLElement>('.manual-option-add')!;
    expect(add.textContent).toContain('คนใหม่');
    add.click();
    expect(pickedNew).toEqual(['คนใหม่']);
  });

  it('does nothing on Enter while a Thai IME composition is committing', async () => {
    fixture.detectChanges();
    await type('เกียร์');
    key('ArrowDown');
    key('Enter', { isComposing: true });
    expect(picked).toEqual([]);
  });

  it('starts with the initial text and lists matches for it', async () => {
    fixture.componentRef.setInput('initialText', 'ตั้ม 19.00');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input().value).toBe('ตั้ม 19.00');
    expect(options().some((o) => o.textContent?.includes('ตั้ม'))).toBe(true);
  });

  it('never offers a player that another row has claimed, and says so on an exact match', async () => {
    fixture.componentRef.setInput('claimedIds', new Set(['p2']));
    fixture.detectChanges();
    await type('เกียร์');
    expect(options().some((o) => o.textContent?.includes('เกียร์') && !o.classList.contains('manual-option-add'))).toBe(false);
    expect(el().textContent).toContain('เกียร์ ถูกเลือกไว้แล้ว');
    expect(el().querySelector('.manual-option-add')).toBeNull();
  });

  it('refuses a name already drafted as a new player', async () => {
    fixture.componentRef.setInput('drafts', new Set(['นก']));
    fixture.detectChanges();
    await type('นก');
    el().querySelector<HTMLElement>('.manual-option-add')!.click();
    fixture.detectChanges();
    expect(pickedNew).toEqual([]);
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('เพิ่มชื่อนี้ไปแล้ว');
  });

  it('builds its ids from idPrefix', async () => {
    fixture.componentRef.setInput('idPrefix', 'manual');
    fixture.detectChanges();
    await type('มด');
    expect(input().id).toBe('manual-add-input');
    expect(options()[0].id).toBe('manual-option-0');
    expect(options()[0].classList.contains('manual-option')).toBe(true);
    expect(options()[0].querySelector('.manual-option-name')).not.toBeNull();
  });

  it('Escape closes an open list first, and a second Escape cancels', async () => {
    fixture.detectChanges();
    await type('มด');
    expect(options().length).toBeGreaterThan(0);
    key('Escape');
    expect(options()).toHaveLength(0);
    expect(cancels).toBe(0);
    key('Escape');
    expect(cancels).toBe(1);
  });

  it('is disabled while the screen is saving', async () => {
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    // ngModel applies a disabled state in a microtask.
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input().disabled).toBe(true);
  });
});
