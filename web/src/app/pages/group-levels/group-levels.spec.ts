import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import type { GroupLevelsResponse } from '../../core/group-levels.model';
import { GroupLevels } from './group-levels';

const B = environment.apiBaseUrl;
const URL = `${B}/groups/g1/levels`;

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

const BUILT_IN = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
const standard = (counts: Record<string, number> = {}): GroupLevelsResponse => ({
  mode: 'standard',
  revision: 0,
  levels: BUILT_IN.map((name, i) => ({ id: `standard:${name}`, name, startingElo: 900 + 100 * i })),
  assignedCounts: Object.fromEntries(BUILT_IN.map((n) => [`standard:${n}`, counts[n] ?? 0])),
});
const custom = (over: Partial<GroupLevelsResponse> = {}): GroupLevelsResponse => ({
  mode: 'custom',
  revision: 3,
  levels: [
    { id: 'a', name: 'มือใหม่', startingElo: 1100 },
    { id: 'b', name: 'กลาง', startingElo: 1200 },
    { id: 'c', name: 'เก่ง', startingElo: 1300 },
  ],
  assignedCounts: { a: 2, b: 0, c: 1 },
  ...over,
});

describe('GroupLevels', () => {
  let fixture: ComponentFixture<GroupLevels>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends Element>(sel: string) => el().querySelector(sel) as T;
  const qa = (sel: string) => [...el().querySelectorAll<HTMLInputElement>(sel)];
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupLevels],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'g1' }) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupLevels);
  });
  afterEach(() => http.verify());

  async function load(body: GroupLevelsResponse) {
    fixture.detectChanges();
    http.expectOne(URL).flush(body);
    await settle();
  }
  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('a standard group lists today\'s eight levels with seeds and offers customizing', async () => {
    await load(standard({ BG: 2 }));
    const rows = qa('[data-standard] .level-row');
    expect(rows).toHaveLength(8);
    expect(rows[0].textContent).toContain('BG');
    expect(rows[0].textContent).toContain('900');
    expect(rows[7].textContent).toContain('1600');
    expect(q('[data-customize]')).toBeTruthy();
    expect(q('[data-editor]')).toBeNull();
  });

  it('always says that a seed edit affects only future assignments, not players already tagged', async () => {
    await load(standard());
    expect(q('[data-seed-caveat]').textContent).toContain('คนที่มีระดับอยู่แล้วคงค่าเดิม');
  });

  it('customizing starts a three-level draft with centered seeds and blank names that cannot be saved yet', async () => {
    await load(standard());
    q<HTMLButtonElement>('[data-customize]').click();
    fixture.detectChanges();
    const elo = qa('.level-elo-input').map((i) => i.value);
    expect(elo).toEqual(['1100', '1200', '1300']);
    expect(qa('.level-name-input').every((i) => i.value === '')).toBe(true);
    expect(q('[data-problem]').textContent).toContain('ต้องมีชื่อ');
    expect(q<HTMLButtonElement>('[data-save]').disabled).toBe(true);
  });

  it('the first switch asks first with the number of labels it will clear, and cancelling sends nothing', async () => {
    await load(standard({ BG: 2, P: 1 }));
    q<HTMLButtonElement>('[data-customize]').click();
    fixture.detectChanges();
    ['มือใหม่', 'กลาง', 'เก่ง'].forEach((n, i) => type(qa('.level-name-input')[i], n));
    q<HTMLButtonElement>('[data-save]').click();
    fixture.detectChanges();
    expect(q('[data-confirm-count]').textContent).toContain('3');
    q<HTMLButtonElement>('[data-confirm-cancel]').click();
    fixture.detectChanges();
    http.expectNone(URL);
    // The draft is still there to continue.
    expect(qa('.level-name-input')[0].value).toBe('มือใหม่');
  });

  it('confirming sends customize with the expected revision and new levels carrying no ids', async () => {
    await load(standard());
    q<HTMLButtonElement>('[data-customize]').click();
    fixture.detectChanges();
    ['มือใหม่', 'กลาง', 'เก่ง'].forEach((n, i) => type(qa('.level-name-input')[i], n));
    q<HTMLButtonElement>('[data-save]').click();
    fixture.detectChanges();
    q<HTMLButtonElement>('[data-confirm-ok]').click();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      action: 'customize',
      expectedRevision: 0,
      levels: [{ name: 'มือใหม่', startingElo: 1100 }, { name: 'กลาง', startingElo: 1200 }, { name: 'เก่ง', startingElo: 1300 }],
    });
    req.flush(custom({ revision: 1 }));
    await settle();
    expect(q('[data-editor]')).toBeTruthy();
    expect(qa('.level-name-input').map((i) => i.value)).toEqual(['มือใหม่', 'กลาง', 'เก่ง']);
  });

  it('custom mode keeps ids on rename and reorder and omits the id of a new level', async () => {
    await load(custom());
    type(qa('.level-name-input')[1], 'กลางๆ');
    (el().querySelectorAll('.row-actions')[2].querySelectorAll('button')[0] as HTMLButtonElement).click(); // move เก่ง up
    fixture.detectChanges();
    // A moved level keeps its own seed, so the host re-spaces them: the draft is flagged until they do.
    expect(q('[data-problem]').textContent).toContain('มากกว่า');
    q<HTMLButtonElement>('[data-add-level]').click();
    fixture.detectChanges();
    type(qa('.level-name-input')[3], 'เทพ');
    [1100, 1200, 1300, 1400].forEach((n, i) => type(qa('.level-elo-input')[i], String(n)));
    q<HTMLButtonElement>('[data-save]').click();
    const req = http.expectOne(URL);
    expect(req.request.body.action).toBe('edit');
    expect(req.request.body.expectedRevision).toBe(3);
    expect(req.request.body.levels.map((l: { id?: string; name: string }) => [l.id, l.name])).toEqual([
      ['a', 'มือใหม่'], ['c', 'เก่ง'], ['b', 'กลางๆ'], [undefined, 'เทพ'],
    ]);
    req.flush(custom({ revision: 4 }));
    await settle();
  });

  it('removing a level someone has is blocked with the reason; an empty one can go', async () => {
    await load(custom());
    const removes = qa('[data-remove]') as unknown as HTMLButtonElement[];
    expect(removes[0].disabled).toBe(true); // 2 players on มือใหม่
    expect(q('[data-remove-blocked]').textContent).toContain('2');
    expect(removes[1].disabled).toBe(false);
    removes[1].click();
    fixture.detectChanges();
    expect(qa('.level-name-input')).toHaveLength(2);
  });

  it('invalid drafts show the problem and cannot be saved: duplicate names, non-increasing seeds, too many', async () => {
    await load(custom());
    type(qa('.level-name-input')[1], 'มือใหม่');
    expect(q('[data-problem]').textContent).toContain('ซ้ำ');
    expect(q<HTMLButtonElement>('[data-save]').disabled).toBe(true);
    type(qa('.level-name-input')[1], 'กลาง');
    type(qa('.level-elo-input')[1], '1100');
    expect(q('[data-problem]').textContent).toContain('มากกว่า');
    type(qa('.level-elo-input')[1], '12.5');
    expect(q('[data-problem]').textContent).toContain('จำนวนเต็ม');
    type(qa('.level-elo-input')[1], '1200');
    expect(q('[data-problem]')).toBeNull();
    http.expectNone(URL);
  });

  it('the suggestion button respaces every seed 100 apart around 1200', async () => {
    await load(custom());
    type(qa('.level-elo-input')[0], '5');
    q<HTMLButtonElement>('[data-suggest]').click();
    fixture.detectChanges();
    // It would overwrite a hand-typed seed, so the first tap only asks.
    expect(qa('.level-elo-input')[0].value).toBe('5');
    expect(q('[data-suggest]').textContent).toContain('กดอีกครั้ง');
    q<HTMLButtonElement>('[data-suggest]').click();
    fixture.detectChanges();
    expect(qa('.level-elo-input').map((i) => i.value)).toEqual(['1100', '1200', '1300']);
  });

  it('seeds that already match the suggestion respace without asking', async () => {
    await load(custom());
    q<HTMLButtonElement>('[data-suggest]').click();
    fixture.detectChanges();
    expect(qa('.level-elo-input').map((i) => i.value)).toEqual(['1100', '1200', '1300']);
    expect(q('[data-suggest]').textContent).not.toContain('กดอีกครั้ง');
  });

  it('a standard group can start from today\'s levels and seeds instead of blank rows', async () => {
    await load(standard());
    q<HTMLButtonElement>('[data-customize-standard]').click();
    fixture.detectChanges();
    expect(qa('.level-name-input').map((i) => i.value)).toEqual(BUILT_IN);
    expect(qa('.level-elo-input')[0].value).toBe('900');
    expect(qa('.level-elo-input')[7].value).toBe('1600');
    expect(q<HTMLButtonElement>('[data-save]').disabled).toBe(false);
  });

  it('the editor explains Elo in plain words and labels the people count', async () => {
    await load(custom());
    expect(q('[data-elo-help]').textContent).toContain('ห่างกัน 100');
    expect(el().textContent).toContain('2 คน');
  });

  it('an open session blocks the save with an explanation and keeps the draft', async () => {
    await load(custom());
    type(qa('.level-name-input')[1], 'กลางๆ');
    q<HTMLButtonElement>('[data-save]').click();
    http.expectOne(URL).flush({ code: 'LEVEL_LADDER_ACTIVE_SESSION' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().textContent).toContain('จบก๊วนก่อน');
    expect(qa('.level-name-input')[1].value).toBe('กลางๆ');
  });

  it('a stale revision reloads the server\'s ladder without discarding the host\'s edits', async () => {
    await load(custom());
    type(qa('.level-name-input')[1], 'กลางๆ');
    q<HTMLButtonElement>('[data-save]').click();
    http.expectOne(URL).flush({ code: 'LEVEL_LADDER_STALE' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(URL).flush(custom({ revision: 9 }));
    await settle();
    expect(el().textContent).toContain('มีการแก้ระดับจากที่อื่น');
    expect(qa('.level-name-input')[1].value).toBe('กลางๆ');
    fixture.detectChanges();
    expect(q<HTMLButtonElement>('[data-save]').disabled).toBe(false);
    q<HTMLButtonElement>('[data-save]').click();
    await settle();
    expect(http.expectOne(URL).request.body.expectedRevision).toBe(9);
  });

  it('an in-use refusal from the server is explained with the number of people', async () => {
    await load(custom());
    qa('[data-remove]')[1].click();
    fixture.detectChanges();
    q<HTMLButtonElement>('[data-save]').click();
    http.expectOne(URL).flush({ code: 'LEVEL_IN_USE', counts: { c: 4 } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().textContent).toContain('4');
    expect(el().textContent).toContain('ลบระดับนี้ไม่ได้');
  });

  it('reset asks first, with the count, then sends reset and shows the standard ladder', async () => {
    await load(custom());
    q<HTMLButtonElement>('[data-reset]').click();
    fixture.detectChanges();
    expect(q('[data-confirm-count]').textContent).toContain('3');
    q<HTMLButtonElement>('[data-confirm-ok]').click();
    const req = http.expectOne(URL);
    expect(req.request.body).toEqual({ action: 'reset', expectedRevision: 3 });
    req.flush({ ...standard(), revision: 4 });
    await settle();
    expect(q('[data-standard]')).toBeTruthy();
  });

  it('leaving with an unsaved draft asks first; a clean page leaves silently', async () => {
    await load(custom());
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(fixture.componentInstance.canDeactivate()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    type(qa('.level-name-input')[1], 'กลางๆ');
    expect(fixture.componentInstance.canDeactivate()).toBe(false);
    expect(ask).toHaveBeenCalled();
    ask.mockRestore();
  });

  it('the editor\'s save row is part of the page flow, not a sticky bar that can cover the reset section', async () => {
    await load(custom());
    expect(q('[data-editor] .editor-actions')).toBeTruthy();
    expect(q('[data-editor] .dialog-actions')).toBeNull();
  });

  it('a group the host does not own shows no usable editor', async () => {
    fixture.detectChanges();
    http.expectOne(URL).flush({}, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(el().textContent).toContain('โหลดข้อมูลระดับไม่สำเร็จ');
    expect(q('[data-editor]')).toBeNull();
    expect(q('[data-customize]')).toBeNull();
  });
});
