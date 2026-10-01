import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AddRuleDialog } from './add-rule-dialog';
import type { CreatePairRuleRequest } from '../../core/pair-rule.model';

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

const players = [
  { id: 'p1', name: 'ตั้ม' },
  { id: 'p2', name: 'เบส' },
  { id: 'p3', name: 'มด' },
];

describe('AddRuleDialog', () => {
  let fixture: ComponentFixture<AddRuleDialog>;
  const root = () => fixture.nativeElement as HTMLElement;
  const select = (name: string) => root().querySelector(`select[name="${name}"]`) as HTMLSelectElement;
  const kindRadio = (kind: string) =>
    root().querySelector(`input[type="radio"][value="${kind}"]`) as HTMLInputElement;
  const submitButton = () => root().querySelector('[data-submit-rule]') as HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AddRuleDialog] }).compileComponents();
    fixture = TestBed.createComponent(AddRuleDialog);
    fixture.componentRef.setInput('players', players);
  });

  async function openDialog(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function choose(name: string, value: string): void {
    const el = select(name);
    el.value = value;
    el.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  it('says the rule persists for the group, not just tonight', async () => {
    await openDialog();
    expect(root().textContent).toContain('บันทึกกับก๊วนถาวร');
  });

  it('explains each rule kind in one line, right where it is chosen', async () => {
    await openDialog();
    const text = root().textContent ?? '';
    expect(text).toContain('ลงทีมเดียวกัน หรือพักพร้อมกัน');
    expect(text).toContain('เป็นคู่แข่งกันได้ แต่ไม่ลงทีมเดียวกัน');
    expect(text).toContain('ไม่ลงคอร์ทเดียวกันเลย');
  });

  it('offers the three kinds as radios with คู่กัน selected by default, and moves the selection', async () => {
    await openDialog();
    const radios = root().querySelectorAll('input[type="radio"][name="kind"]');
    expect(radios.length).toBe(3);
    expect(kindRadio('must-pair').checked).toBe(true);
    kindRadio('never-teammates').click();
    fixture.detectChanges();
    expect(kindRadio('never-teammates').checked).toBe(true);
    expect(kindRadio('must-pair').checked).toBe(false);
  });

  it('keeps submit disabled until both players are chosen', async () => {
    await openDialog();
    expect(submitButton().disabled).toBe(true);
    choose('playerA', 'p1');
    expect(submitButton().disabled).toBe(true);
    choose('playerB', 'p2');
    expect(submitButton().disabled).toBe(false);
  });

  it('does not offer the first player as the second, and clears a clash', async () => {
    await openDialog();
    choose('playerA', 'p1');
    choose('playerB', 'p2');
    const optionsB = Array.from(select('playerB').options).map((o) => o.textContent?.trim());
    expect(optionsB).not.toContain('ตั้ม');

    choose('playerA', 'p2');
    expect(select('playerB').value).toBe('');
    expect(submitButton().disabled).toBe(true);
  });

  it('emits the chosen pair and kind, defaulting to คู่กัน', async () => {
    await openDialog();
    let emitted: CreatePairRuleRequest | undefined;
    fixture.componentInstance.add.subscribe((v) => (emitted = v));
    choose('playerA', 'p1');
    choose('playerB', 'p3');
    submitButton().click();
    expect(emitted).toEqual({ playerAId: 'p1', playerBId: 'p3', kind: 'must-pair' });
  });

  it('emits another kind when chosen', async () => {
    await openDialog();
    let emitted: CreatePairRuleRequest | undefined;
    fixture.componentInstance.add.subscribe((v) => (emitted = v));
    choose('playerA', 'p1');
    choose('playerB', 'p2');
    kindRadio('never-same-court').click();
    fixture.detectChanges();
    submitButton().click();
    expect(emitted?.kind).toBe('never-same-court');
  });

  it('shows the server error and blocks submit while saving', async () => {
    await openDialog();
    choose('playerA', 'p1');
    choose('playerB', 'p2');
    fixture.componentRef.setInput('error', 'ผู้เล่นคู่นี้มีกฎอยู่แล้ว');
    fixture.componentRef.setInput('saving', true);
    fixture.detectChanges();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('มีกฎอยู่แล้ว');
    expect(submitButton().disabled).toBe(true);
  });

  it('starts fresh each time it opens', async () => {
    await openDialog();
    choose('playerA', 'p1');
    choose('playerB', 'p2');
    fixture.componentInstance.close();
    await openDialog();
    expect(select('playerA').value).toBe('');
    expect(select('playerB').value).toBe('');
  });
});
