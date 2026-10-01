import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShuttleCorrectionDialog } from './shuttle-correction-dialog';

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

const shuttles = [
  { id: 's1', number: 1, usable: true },
  { id: 's2', number: 2, usable: false },
  { id: 's3', number: 3, usable: true },
];

describe('ShuttleCorrectionDialog', () => {
  let fixture: ComponentFixture<ShuttleCorrectionDialog>;
  const root = () => fixture.nativeElement as HTMLElement;
  const chip = (id: string) => root().querySelector(`[data-shuttle-chip="${id}"]`) as HTMLButtonElement;
  const save = () => root().querySelector('[data-save-correction]') as HTMLButtonElement;
  const openNew = () => root().querySelector('input[name="openNew"]') as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ShuttleCorrectionDialog] }).compileComponents();
    fixture = TestBed.createComponent(ShuttleCorrectionDialog);
    fixture.componentRef.setInput('shuttles', shuttles);
    fixture.componentRef.setInput('initialIds', ['s1']);
    fixture.componentRef.setInput('rowLabel', 'คอร์ท 2 · แมตช์ 3');
  });

  async function open(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function emitted() {
    const out: { shuttleIds: string[]; openNew: boolean }[] = [];
    fixture.componentInstance.save.subscribe((v) => out.push(v));
    return out;
  }

  it('wears the shared sheet shell and names the game', async () => {
    await open();
    expect(root().querySelector('dialog')!.classList.contains('sheet-dialog')).toBe(true);
    expect(root().textContent).toContain('คอร์ท 2 · แมตช์ 3');
  });

  it('starts with the game\'s current shuttles pressed, and marks retired ones', async () => {
    await open();
    expect(chip('s1').getAttribute('aria-pressed')).toBe('true');
    expect(chip('s3').getAttribute('aria-pressed')).toBe('false');
    expect(chip('s2').textContent).toContain('เลิกใช้');
  });

  it('lets the host add a retired shuttle that really was played', async () => {
    await open();
    const got = emitted();
    chip('s2').click();
    save().click();
    expect(got).toEqual([{ shuttleIds: ['s1', 's2'], openNew: false }]);
  });

  it('can set none at all (a known zero), which is not the same as unknown', async () => {
    await open();
    const got = emitted();
    chip('s1').click();
    save().click();
    expect(got).toEqual([{ shuttleIds: [], openNew: false }]);
    expect(root().textContent).toContain('ไม่ได้ใช้ลูกแบด');
  });

  it('can open a missed new shuttle alongside the set', async () => {
    await open();
    const got = emitted();
    openNew().click();
    fixture.detectChanges();
    save().click();
    expect(got).toEqual([{ shuttleIds: ['s1'], openNew: true }]);
  });

  it('emits shuttle ids in number order whatever the tap order', async () => {
    fixture.componentRef.setInput('initialIds', []);
    await open();
    const got = emitted();
    chip('s3').click();
    chip('s1').click();
    save().click();
    expect(got[0].shuttleIds).toEqual(['s1', 's3']);
  });

  it('shows the server error and blocks saving while a write is in flight', async () => {
    await open();
    fixture.componentRef.setInput('error', 'ข้อมูลถูกแก้ไขจากอุปกรณ์อื่นแล้ว');
    fixture.componentRef.setInput('saving', true);
    fixture.detectChanges();
    expect(root().querySelector('[role="alert"]')!.textContent).toContain('อุปกรณ์อื่น');
    expect(save().disabled).toBe(true);
    expect(chip('s1').disabled).toBe(true);
  });

  it('starts fresh from the initial set each time it opens', async () => {
    await open();
    chip('s3').click();
    fixture.componentInstance.close();
    await open();
    expect(chip('s3').getAttribute('aria-pressed')).toBe('false');
    expect(openNew().checked).toBe(false);
  });
});
