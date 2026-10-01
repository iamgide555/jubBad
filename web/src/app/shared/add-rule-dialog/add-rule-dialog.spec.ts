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
  const chip = (id: string) => root().querySelector(`[data-player-chip="${id}"]`) as HTMLButtonElement;
  const kindRadio = (kind: string) =>
    root().querySelector(`input[type="radio"][value="${kind}"]`) as HTMLInputElement;
  const submitButton = () => root().querySelector('[data-submit-rule]') as HTMLButtonElement;
  const summary = () => root().querySelector('.picked-summary')!.textContent!.trim();

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

  function tap(id: string): void {
    chip(id).click();
    fixture.detectChanges();
  }

  it('wears the shared sheet-dialog shell, not its own copy of the styles', () => {
    fixture.detectChanges();
    expect(root().querySelector('dialog')!.classList.contains('sheet-dialog')).toBe(true);
  });

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
    expect(root().querySelectorAll('input[type="radio"][name="kind"]').length).toBe(3);
    expect(kindRadio('must-pair').checked).toBe(true);
    kindRadio('never-teammates').click();
    fixture.detectChanges();
    expect(kindRadio('never-teammates').checked).toBe(true);
    expect(kindRadio('must-pair').checked).toBe(false);
  });

  it('lists every player on tonight\'s roster as a chip, none pressed to start', async () => {
    await openDialog();
    expect(root().querySelectorAll('[data-player-chip]').length).toBe(3);
    expect(root().querySelectorAll('[data-player-chip][aria-pressed="true"]').length).toBe(0);
    expect(summary()).toContain('แตะชื่อผู้เล่น 2 คน');
  });

  it('keeps submit disabled until two players are picked', async () => {
    await openDialog();
    expect(submitButton().disabled).toBe(true);
    tap('p1');
    expect(submitButton().disabled).toBe(true);
    tap('p2');
    expect(submitButton().disabled).toBe(false);
  });

  it('shows who is picked, and tapping a picked chip drops it', async () => {
    await openDialog();
    tap('p1');
    tap('p2');
    expect(summary()).toBe('ตั้ม + เบส');
    expect(chip('p1').getAttribute('aria-pressed')).toBe('true');
    tap('p1');
    expect(chip('p1').getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBe('เบส');
    expect(submitButton().disabled).toBe(true);
  });

  it('a third tap swaps out the later pick, so the host never has to clear first', async () => {
    await openDialog();
    tap('p1');
    tap('p2');
    tap('p3');
    expect(chip('p1').getAttribute('aria-pressed')).toBe('true');
    expect(chip('p2').getAttribute('aria-pressed')).toBe('false');
    expect(chip('p3').getAttribute('aria-pressed')).toBe('true');
    expect(summary()).toBe('ตั้ม + มด');
  });

  it('emits the chosen pair and kind, defaulting to คู่กัน', async () => {
    await openDialog();
    let emitted: CreatePairRuleRequest | undefined;
    fixture.componentInstance.add.subscribe((v) => (emitted = v));
    tap('p1');
    tap('p3');
    submitButton().click();
    expect(emitted).toEqual({ playerAId: 'p1', playerBId: 'p3', kind: 'must-pair' });
  });

  it('emits another kind when chosen', async () => {
    await openDialog();
    let emitted: CreatePairRuleRequest | undefined;
    fixture.componentInstance.add.subscribe((v) => (emitted = v));
    tap('p1');
    tap('p2');
    kindRadio('never-same-court').click();
    fixture.detectChanges();
    submitButton().click();
    expect(emitted?.kind).toBe('never-same-court');
  });

  it('shows the server error and blocks submit while saving', async () => {
    await openDialog();
    tap('p1');
    tap('p2');
    fixture.componentRef.setInput('error', 'ผู้เล่นคู่นี้มีกฎอยู่แล้ว');
    fixture.componentRef.setInput('saving', true);
    fixture.detectChanges();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('มีกฎอยู่แล้ว');
    expect(submitButton().disabled).toBe(true);
  });

  it('starts fresh each time it opens', async () => {
    await openDialog();
    tap('p1');
    tap('p2');
    fixture.componentInstance.close();
    await openDialog();
    expect(root().querySelectorAll('[data-player-chip][aria-pressed="true"]').length).toBe(0);
    expect(submitButton().disabled).toBe(true);
  });
});
