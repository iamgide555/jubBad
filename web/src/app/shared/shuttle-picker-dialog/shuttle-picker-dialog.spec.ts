import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShuttlePickerDialog } from './shuttle-picker-dialog';
import type { ShuttleChoice, ShuttleRef } from '../../core/shuttle.model';

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

const s = (number: number): ShuttleRef => ({ id: `s${number}`, number });

describe('ShuttlePickerDialog', () => {
  let fixture: ComponentFixture<ShuttlePickerDialog>;
  const root = () => fixture.nativeElement as HTMLElement;
  const option = (key: string) => root().querySelector(`input[type="radio"][value="${key}"]`) as HTMLInputElement | null;
  const chip = (id: string) => root().querySelector(`[data-shuttle-chip="${id}"]`) as HTMLButtonElement | null;
  const submit = () => root().querySelector('[data-submit-shuttle]') as HTMLButtonElement;
  const retire = () => root().querySelector('input[name="retirePrevious"]') as HTMLInputElement | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ShuttlePickerDialog] }).compileComponents();
    fixture = TestBed.createComponent(ShuttlePickerDialog);
    fixture.componentRef.setInput('mode', 'confirm');
    fixture.componentRef.setInput('courtLabel', 'คอร์ท 2');
    fixture.componentRef.setInput('lastShuttle', null);
    fixture.componentRef.setInput('options', []);
  });

  async function open(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function emitted(): { choice: ShuttleChoice; retirePrevious: boolean }[] {
    const out: { choice: ShuttleChoice; retirePrevious: boolean }[] = [];
    fixture.componentInstance.choose.subscribe((v) => out.push(v));
    return out;
  }

  it('wears the shared sheet-dialog shell and names the court', async () => {
    await open();
    expect(root().querySelector('dialog')!.classList.contains('sheet-dialog')).toBe(true);
    expect(root().textContent).toContain('คอร์ท 2');
  });

  it('defaults to opening a new shuttle when the court has no reusable one', async () => {
    await open();
    expect(option('last')).toBeNull();
    expect(option('new')!.checked).toBe(true);
  });

  it('defaults to reusing the court\'s last shuttle when it is available, and names it', async () => {
    fixture.componentRef.setInput('lastShuttle', s(3));
    await open();
    expect(option('last')!.checked).toBe(true);
    expect(root().textContent).toContain('#3');
  });

  it('lists the other idle shuttles as chips and picks one', async () => {
    fixture.componentRef.setInput('options', [s(1), s(4)]);
    await open();
    expect(chip('s1')).toBeTruthy();
    expect(chip('s4')).toBeTruthy();
    const got = emitted();
    chip('s4')!.click();
    fixture.detectChanges();
    expect(chip('s4')!.getAttribute('aria-pressed')).toBe('true');
    submit().click();
    expect(got).toEqual([{ choice: { kind: 'existing', shuttleId: 's4' }, retirePrevious: false }]);
  });

  it('emits reuse-last and open-new choices', async () => {
    fixture.componentRef.setInput('lastShuttle', s(3));
    await open();
    const got = emitted();
    submit().click();
    option('new')!.click();
    fixture.detectChanges();
    submit().click();
    expect(got).toEqual([
      { choice: { kind: 'existing', shuttleId: 's3' }, retirePrevious: false },
      { choice: { kind: 'new' }, retirePrevious: false },
    ]);
  });

  it('offers no reuse or chip rows when nothing else is available, only a new shuttle', async () => {
    await open();
    expect(root().querySelectorAll('[data-shuttle-chip]').length).toBe(0);
    expect(root().querySelectorAll('input[type="radio"]').length).toBe(1);
  });

  it('confirm mode has no retire option; switch mode does, off by default', async () => {
    await open();
    expect(retire()).toBeNull();

    fixture.componentRef.setInput('mode', 'switch');
    fixture.componentRef.setInput('lastShuttle', s(2));
    fixture.detectChanges();
    expect(retire()).toBeTruthy();
    expect(retire()!.checked).toBe(false);
  });

  it('can start with the retire option already ticked (mark unusable)', async () => {
    fixture.componentRef.setInput('mode', 'switch');
    fixture.componentRef.setInput('lastShuttle', s(2));
    fixture.componentRef.setInput('retireByDefault', true);
    await open();
    expect(retire()!.checked).toBe(true);
    const got = emitted();
    option('new')!.click();
    submit().click();
    expect(got).toEqual([{ choice: { kind: 'new' }, retirePrevious: true }]);
  });

  it('in switch mode the current shuttle is shown but not offered as a choice', async () => {
    fixture.componentRef.setInput('mode', 'switch');
    fixture.componentRef.setInput('lastShuttle', s(2));
    await open();
    expect(root().textContent).toContain('#2');
    expect(option('last')).toBeNull();
  });

  it('shows the server error and blocks everything while saving', async () => {
    fixture.componentRef.setInput('options', [s(1)]);
    await open();
    fixture.componentRef.setInput('error', 'ลูกแบดลูกนี้ใช้ไม่ได้');
    fixture.componentRef.setInput('saving', true);
    fixture.detectChanges();
    expect(root().querySelector('[role="alert"]')!.textContent).toContain('ใช้ไม่ได้');
    expect(submit().disabled).toBe(true);
    expect(chip('s1')!.disabled).toBe(true);
  });

  it('starts fresh each time it opens', async () => {
    fixture.componentRef.setInput('options', [s(1)]);
    await open();
    chip('s1')!.click();
    fixture.componentInstance.close();
    await open();
    expect(chip('s1')!.getAttribute('aria-pressed')).toBe('false');
    expect(option('new')!.checked).toBe(true);
  });
});
