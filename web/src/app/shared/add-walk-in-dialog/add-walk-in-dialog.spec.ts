import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AddWalkInDialog } from './add-walk-in-dialog';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

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

const players: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
];

describe('AddWalkInDialog', () => {
  let fixture: ComponentFixture<AddWalkInDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AddWalkInDialog] }).compileComponents();
    fixture = TestBed.createComponent(AddWalkInDialog);
    fixture.componentRef.setInput('players', players);
    fixture.componentRef.setInput('excludedIds', new Set());
  });

  async function openDialog(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function searchInput(): HTMLInputElement {
    return (fixture.nativeElement as HTMLElement).querySelector('input[name="search"]') as HTMLInputElement;
  }

  function type(value: string): void {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('lists a matching existing player and emits their playerId when picked', async () => {
    await openDialog();
    type('ตั้ม');

    const results = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-candidate]');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('ตั้ม');

    let emitted: { playerId: string } | { name: string } | undefined;
    fixture.componentInstance.add.subscribe((e) => (emitted = e));
    (results[0] as HTMLButtonElement).click();

    expect(emitted).toEqual({ playerId: 'p1' });
  });

  it('offers "add as new" for a query matching nobody, and emits a name', async () => {
    await openDialog();
    type('มะปราง');

    const addNewButton = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-add-new]'
    ) as HTMLButtonElement;
    expect(addNewButton).not.toBeNull();
    expect(addNewButton.textContent).toContain('มะปราง');

    let emitted: { playerId: string } | { name: string } | undefined;
    fixture.componentInstance.add.subscribe((e) => (emitted = e));
    addNewButton.click();

    expect(emitted).toEqual({ name: 'มะปราง' });
  });

  it('excludes players already on the roster from the search results', async () => {
    fixture.componentRef.setInput('excludedIds', new Set(['p1']));
    await openDialog();
    type('ตั้ม');

    const results = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-candidate]');
    expect(results.length).toBe(0);
    const addNewButton = (fixture.nativeElement as HTMLElement).querySelector('[data-add-new]');
    expect(addNewButton).not.toBeNull();
  });
});
