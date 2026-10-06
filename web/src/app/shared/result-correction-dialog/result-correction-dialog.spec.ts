import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResultCorrectionDialog, type ResultCorrection } from './result-correction-dialog';

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

describe('ResultCorrectionDialog', () => {
  let fixture: ComponentFixture<ResultCorrectionDialog>;
  let saved: ResultCorrection[];
  const root = () => fixture.nativeElement as HTMLElement;
  const choice = (w: string) => root().querySelector(`[data-winner="${w}"]`) as HTMLButtonElement;
  const input = (name: string) => root().querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const save = () => root().querySelector('[data-save-result]') as HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ResultCorrectionDialog] }).compileComponents();
    fixture = TestBed.createComponent(ResultCorrectionDialog);
    saved = [];
    fixture.componentInstance.save.subscribe((e) => saved.push(e));
    fixture.componentRef.setInput('teamA', ['นก', 'เจ']);
    fixture.componentRef.setInput('teamB', ['ต้น', 'แมน']);
    fixture.componentRef.setInput('initial', { winner: 'A', scoreA: 21, scoreB: 15 });
  });

  async function open(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('opens on the recorded result and names both sides', async () => {
    await open();
    expect(choice('A').getAttribute('aria-pressed')).toBe('true');
    expect(choice('A').textContent).toContain('นก + เจ');
    expect(choice('B').textContent).toContain('ต้น + แมน');
    expect(input('scoreA').value).toBe('21');
  });

  it('emits the flipped winner with a matching score', async () => {
    await open();
    choice('B').click();
    input('scoreA').value = '18';
    input('scoreA').dispatchEvent(new Event('input'));
    input('scoreB').value = '21';
    input('scoreB').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    save().click();
    expect(saved).toEqual([{ winner: 'B', scoreA: 18, scoreB: 21 }]);
  });

  it('refuses a score that disagrees with the winner, without emitting', async () => {
    await open();
    choice('B').click(); // scores still 21-15 for A
    fixture.detectChanges();
    save().click();
    fixture.detectChanges();
    expect(saved).toEqual([]);
    expect(root().querySelector('[role="alert"]')!.textContent).toContain('ไม่ตรง');
  });

  it('allows "no result" with the scores cleared', async () => {
    await open();
    choice('none').click();
    input('scoreA').value = '';
    input('scoreA').dispatchEvent(new Event('input'));
    input('scoreB').value = '';
    input('scoreB').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    save().click();
    expect(saved).toEqual([{ winner: null, scoreA: null, scoreB: null }]);
  });
});
