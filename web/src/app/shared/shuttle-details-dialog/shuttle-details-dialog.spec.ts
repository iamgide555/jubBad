import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShuttleDetailsDialog, type ShuttleDetailsPatch } from './shuttle-details-dialog';

// jsdom 28's HTMLDialogElement implements no showModal()/close() at all (see
// jsdom's HTMLDialogElement-impl.js, an empty subclass) — this is the first
// dialog to get test coverage in this codebase, so each spec that opens one
// needs this shim. Guarded so a future jsdom that implements them takes over.
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

describe('ShuttleDetailsDialog', () => {
  let fixture: ComponentFixture<ShuttleDetailsDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ShuttleDetailsDialog],
    }).compileComponents();
    fixture = TestBed.createComponent(ShuttleDetailsDialog);
  });

  function inputs() {
    const el = fixture.nativeElement as HTMLElement;
    return {
      count: el.querySelector('input[name="shuttleCount"]') as HTMLInputElement | null,
      price: el.querySelector('input[name="shuttlePrice"]') as HTMLInputElement | null,
    };
  }

  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  /**
   * NgModel defers some of its own DOM writes (`_updateValue`, and the
   * `[disabled]` binding on a freshly-mounted control) to a microtask to
   * avoid an ExpressionChangedAfterChecked error — the same behavior already
   * documented in session-dashboard.spec.ts's "cancel discards the draft"
   * test. Opening the dialog mounts a brand-new `<form>` via `@if`, so every
   * test that reads DOM state right after `open()` needs this flush first.
   */
  async function openDialog(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  async function flush(): Promise<void> {
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function buttonWith(text: string): HTMLButtonElement | undefined {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes(text));
  }

  function confirmSpy(): ShuttleDetailsPatch[] {
    const emitted: ShuttleDetailsPatch[] = [];
    fixture.componentInstance.confirm.subscribe((p) => emitted.push(p));
    return emitted;
  }

  it('is not in the DOM until open() is called', () => {
    fixture.detectChanges();
    expect(inputs().count).toBeNull();
  });

  it('renders null as blank, distinct from 0', async () => {
    fixture.componentRef.setInput('shuttleCount', 0);
    fixture.componentRef.setInput('shuttlePriceSatang', null);
    await openDialog();

    const { count, price } = inputs();
    expect(count!.value).toBe('0');
    expect(price!.value).toBe('');
  });

  it('renders genuinely blank inputs when nothing was ever recorded', async () => {
    await openDialog();

    const { count, price } = inputs();
    expect(count!.value).toBe('');
    expect(price!.value).toBe('');
  });

  it('renders a saved price back as baht, not satang', async () => {
    fixture.componentRef.setInput('shuttleCount', 12);
    fixture.componentRef.setInput('shuttlePriceSatang', 8050);
    await openDialog();

    const { count, price } = inputs();
    expect(count!.value).toBe('12');
    expect(price!.value).toBe('80.50');
  });

  it('emits only the field the host actually changed', async () => {
    fixture.componentRef.setInput('shuttleCount', 5);
    fixture.componentRef.setInput('shuttlePriceSatang', 1000);
    await openDialog();
    const emitted = confirmSpy();

    type(inputs().count!, '12');
    buttonWith('บันทึก')!.click();

    expect(emitted).toEqual([{ shuttleCount: 12 }]);
  });

  it('emits explicit null when the host clears a previously-set field', async () => {
    fixture.componentRef.setInput('shuttleCount', 5);
    await openDialog();
    const emitted = confirmSpy();

    type(inputs().count!, '');
    buttonWith('บันทึก')!.click();

    expect(emitted).toEqual([{ shuttleCount: null }]);
  });

  it('converts 80.50 baht to exactly 8050 satang on confirm', async () => {
    await openDialog();
    const emitted = confirmSpy();

    type(inputs().price!, '80.50');
    buttonWith('บันทึก')!.click();

    expect(emitted).toEqual([{ shuttlePriceSatang: 8050 }]);
  });

  it('rejects a price with more than 2 decimal places instead of rounding, without emitting', async () => {
    await openDialog();
    const emitted = confirmSpy();

    type(inputs().price!, '80.505');
    buttonWith('บันทึก')!.click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ราคาต่อลูกต้องไม่ติดลบ และมีทศนิยมไม่เกิน 2 ตำแหน่ง'
    );
  });

  it('rejects an invalid count without emitting', async () => {
    await openDialog();
    const emitted = confirmSpy();

    type(inputs().count!, 'abc');
    buttonWith('บันทึก')!.click();
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'จำนวนลูกแบดต้องเป็นจำนวนเต็มไม่ติดลบ'
    );
  });

  it('emits an empty patch when nothing was touched', async () => {
    await openDialog();
    const emitted = confirmSpy();

    buttonWith('บันทึก')!.click();

    expect(emitted).toEqual([{}]);
  });

  it('does not let a background change to the committed value clobber a typed draft', async () => {
    fixture.componentRef.setInput('shuttleCount', 5);
    await openDialog();
    type(inputs().count!, '99');

    fixture.componentRef.setInput('shuttleCount', 42);
    fixture.detectChanges();

    expect(inputs().count!.value).toBe('99');
  });

  it('reopening resets the drafts back to the committed values', async () => {
    fixture.componentRef.setInput('shuttleCount', 5);
    await openDialog();
    type(inputs().count!, '99');
    fixture.componentInstance.close();
    fixture.detectChanges();

    await openDialog();

    expect(inputs().count!.value).toBe('5');
  });

  it('disables both inputs and both buttons while saving', async () => {
    await openDialog();
    fixture.componentRef.setInput('saving', true);
    await flush();

    const { count, price } = inputs();
    expect(count!.disabled).toBe(true);
    expect(price!.disabled).toBe(true);
    expect(buttonWith('บันทึก')!.disabled).toBe(true);
    expect(buttonWith('ยกเลิก')!.disabled).toBe(true);
  });

  it('renders the [error] input as an alert', async () => {
    await openDialog();
    fixture.componentRef.setInput('error', 'บันทึกไม่สำเร็จ');
    fixture.detectChanges();

    const el = (fixture.nativeElement as HTMLElement).querySelector('p.error[role="alert"]');
    expect(el?.textContent).toContain('บันทึกไม่สำเร็จ');
  });

  it('close() closes the dialog and removes the form from the DOM', async () => {
    await openDialog();
    expect(inputs().count).not.toBeNull();

    fixture.componentInstance.close();
    fixture.detectChanges();

    expect(inputs().count).toBeNull();
  });
});
