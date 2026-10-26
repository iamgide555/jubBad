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
  const winnerBtn = (w: string) => root().querySelector(`[data-winner="${w}"]`) as HTMLButtonElement;
  const input = (name: string) => root().querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const type = (name: string, value: string) => {
    input(name).value = value;
    input(name).dispatchEvent(new Event('input'));
  };

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

  it('shows one team per side with the recorded score and marks the recorded winner', async () => {
    await open();
    const teams = [...root().querySelectorAll('.fix-team')].map((t) => [...t.querySelectorAll('li')].map((li) => li.textContent));
    expect(teams).toEqual([['นก', 'เจ'], ['ต้น', 'แมน']]);
    expect(input('scoreA').value).toBe('21');
    expect(input('scoreB').value).toBe('15');
    expect(winnerBtn('A').classList.contains('recorded')).toBe(true);
    expect(winnerBtn('B').classList.contains('recorded')).toBe(false);
  });

  it('shows the recorded score even when the parent hands over the game in the same tick as open()', async () => {
    fixture.componentRef.setInput('initial', { winner: null, scoreA: null, scoreB: null });
    fixture.detectChanges();
    fixture.componentInstance.open(); // reads the previous game's (blank) result
    fixture.componentRef.setInput('initial', { winner: 'B', scoreA: 14, scoreB: 21 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input('scoreA').value).toBe('14');
    expect(input('scoreB').value).toBe('21');
    expect(winnerBtn('B').classList.contains('recorded')).toBe(true);
  });

  it('has no separate save step: only the scores, the two winner buttons, and the quiet escapes', async () => {
    await open();
    expect(root().querySelector('[data-save-result]')).toBeNull();
    expect(root().querySelectorAll('input').length).toBe(2);
    expect(winnerBtn('A').getAttribute('aria-label')).toContain('นก & เจ');
  });

  it('saves the flipped winner with a matching score when its team button is tapped', async () => {
    await open();
    type('scoreA', '18');
    type('scoreB', '21');
    winnerBtn('B').click();
    expect(saved).toEqual([{ winner: 'B', scoreA: 18, scoreB: 21 }]);
  });

  it('refuses a winner that disagrees with the scores on the page, without emitting', async () => {
    await open();
    winnerBtn('B').click(); // scores still 21-15 for A
    fixture.detectChanges();
    expect(saved).toEqual([]);
    expect(root().querySelector('[role="alert"]')!.textContent).toContain('ไม่ตรง');
  });

  it('saves just the winner when the scores are left empty', async () => {
    await open();
    type('scoreA', '');
    type('scoreB', '');
    winnerBtn('B').click();
    expect(saved).toEqual([{ winner: 'B', scoreA: null, scoreB: null }]);
  });

  it('asks for both scores or neither', async () => {
    await open();
    type('scoreB', '');
    winnerBtn('A').click();
    fixture.detectChanges();
    expect(saved).toEqual([]);
    expect(root().querySelector('[role="alert"]')!.textContent).toContain('ครบทั้งสองทีม');
  });

  it('records "no result" and clears the scores without making the host empty the boxes first', async () => {
    await open();
    winnerBtn('none').click();
    expect(saved).toEqual([{ winner: null, scoreA: null, scoreB: null }]);
  });
});
