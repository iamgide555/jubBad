import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { LiveSessionService } from '../../../core/live-session.service';
import type { Session } from '../../../core/session.model';
import { LineupQueue } from './lineup-queue';

const B = environment.apiBaseUrl;

function session(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1', groupCode: 'group1', date: null, venue: null, courtCount: 1,
    shuttleCount: null, shuttlePriceSatang: null, endedAt: null, rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'], restingPlayerIds: [], queueGames: {},
    createdAt: '2026-09-08T12:00:00.000Z', serverNow: '2026-09-08T12:00:00.000Z',
    mode: 'variety', queueBy: 'games', lastPlayedAt: {}, activatedAt: {}, waitlistPlayerIds: [],
    courts: [{ status: 'idle', format: 'doubles', mode: 'variety' }], courtLabels: [],
    editableCourtCount: 1, ...overrides,
  };
}

describe('LineupQueue', () => {
  let fixture: ComponentFixture<LineupQueue>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  async function load(s: Session) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LineupQueue);
    fixture.componentRef.setInput('players', [
      { id: 'p1', name: 'ตั้ม', aliases: [] }, { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p3', name: 'โอ', aliases: [] }, { id: 'p4', name: 'นัท', aliases: [] },
      { id: 'p5', name: 'ปอ', aliases: [] },
    ]);
    fixture.componentRef.setInput('waiting', [
      { id: 'p1', name: 'ตั้ม' }, { id: 'p2', name: 'เบส' }, { id: 'p5', name: 'ปอ' },
    ]);
    fixture.detectChanges();
    TestBed.tick();
    http.expectOne(`${B}/sessions/sess1`).flush(s);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  it('shows saved lineups in order, with open seats as quiet plus buttons', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: ['p4', null], blocked: [] }],
    }));
    const seats = Array.from(el().querySelectorAll('.lq-seat')).map((b) => b.textContent?.trim());
    expect(seats).toEqual(['โอ', '', 'นัท', '']);
    expect(el().querySelectorAll('.lq-seat.is-empty').length).toBe(2);
  });

  it('says what a lineup is waiting for instead of flagging an error', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', 'p4'], teamB: [null, null], blocked: [{ playerId: 'p3', reason: 'on-court' }, { playerId: 'p4', reason: 'resting' }] }],
    }));
    expect(el().querySelector('.lq-seat.is-waiting')).toBeTruthy();
    const status = el().querySelector('.lq-status')?.textContent ?? '';
    expect(status).toContain('รอ โอ เล่นจบก่อน');
    expect(status).toContain('นัท พักอยู่');
  });

  const click = (selector: string, index = 0) => {
    (el().querySelectorAll(selector)[index] as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  const pickerNames = () =>
    Array.from(el().querySelectorAll('.lq-picker .chip-pick')).map((b) => b.textContent?.replace(/\s+/g, ' ').trim());

  it('keeps a new lineup local until Save, then sends the whole lineup in one request', async () => {
    await load(session());
    click('.lq-add');
    click('.is-editing .lq-seat');
    expect(pickerNames()).toEqual(['ตั้ม', 'เบส', 'ปอ']);

    click('.lq-picker .chip-pick');
    click('.is-editing .lq-seat', 2);
    click('.lq-picker .chip-pick'); // เบส
    // Two players placed and nothing has gone to the server yet.
    http.expectNone(`${B}/sessions/sess1/queue`);

    click('.lq-save');
    const req = http.expectOne(`${B}/sessions/sess1/queue`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ teamA: ['p1', null], teamB: ['p2', null] });
    req.flush({ ok: true, id: 'q1' });
  });

  it('cannot Save an empty draft, and Cancel discards it', async () => {
    await load(session());
    click('.lq-add');
    expect((el().querySelector('.lq-save') as HTMLButtonElement).disabled).toBe(true);
    click('.lq-cancel');
    expect(el().querySelector('.is-editing')).toBeNull();
  });

  it('keeps the draft when the server refuses it, showing the reason', async () => {
    await load(session());
    click('.lq-add');
    click('.is-editing .lq-seat');
    click('.lq-picker .chip-pick');
    click('.lq-save');
    http
      .expectOne(`${B}/sessions/sess1/queue`)
      .flush({ code: 'PLAYER_ALREADY_QUEUED' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(el().querySelector('.lq-error')?.textContent).toContain('ผู้เล่นคนนี้อยู่ในคิวล่วงหน้าแล้ว');
    expect(el().querySelector('.is-editing .lq-seat:not(.is-empty)')).toBeTruthy();
  });

  it('leaves players already lined up out of the picker', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p1', null], teamB: [null, null], blocked: [] }],
    }));
    click('.lq-add');
    click('.is-editing .lq-seat');
    expect(pickerNames()).toEqual(['เบส', 'ปอ']);
  });

  it('edits a saved lineup as a copy and saves it through replace', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', 'p4'], teamB: [null, null], blocked: [] }],
    }));
    click('.lq-entry .lq-seat', 0); // starts an edit of q1
    click('.is-editing .lq-seat', 0); // takes p3 out of the copy
    http.expectNone(`${B}/sessions/sess1/queue/q1`);
    click('.lq-save');
    const req = http.expectOne(`${B}/sessions/sess1/queue/q1`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ teamA: [null, 'p4'], teamB: [null, null] });
    req.flush({ ok: true });
  });

  it('drops an edit whose lineup a court has just taken', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', 'p4'], teamB: [null, null], blocked: [] }],
    }));
    click('.lq-entry .lq-seat', 0);
    expect(el().querySelector('.lq-save')).toBeTruthy();
    TestBed.inject(LiveSessionService).sessionResource.set(session({ lineupQueue: [] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(el().querySelector('.lq-save')).toBeNull();
  });

  it('clears every lineup with one request', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: [null, null], blocked: [] }],
    }));
    click('.lq-clear'); // arms: nothing is deleted by the first tap
    http.expectNone(`${B}/sessions/sess1/queue`);
    expect(el().querySelector('.lq-clear')?.textContent).toContain('แตะอีกครั้ง');
    click('.lq-clear');
    const req = http.expectOne(`${B}/sessions/sess1/queue`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });

  it('hides reorder arrows with a single lineup, and only shows them with several', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: [null, null], blocked: [] }],
    }));
    expect(el().querySelectorAll('.lq-tool').length).toBe(1);
    TestBed.inject(LiveSessionService).sessionResource.set(session({
      lineupQueue: [
        { id: 'q1', position: 0, teamA: ['p3', null], teamB: [null, null], blocked: [] },
        { id: 'q2', position: 1, teamA: ['p4', null], teamB: [null, null], blocked: [] },
      ],
    }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(el().querySelectorAll('.lq-tool').length).toBe(6);
  });

  it('makes Save the primary action while editing and Done the quiet one', async () => {
    await load(session());
    expect(el().querySelector('.lq-done')?.classList.contains('is-quiet')).toBe(false);
    click('.lq-add');
    expect(el().querySelector('.lq-done')?.classList.contains('is-quiet')).toBe(true);
    expect(el().querySelector('.lq-foot .lq-save')).toBeTruthy();
  });

  it('offers players who are still playing too, after the waiting ones, and not resting ones', async () => {
    await load(session({
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
      restingPlayerIds: ['p5'],
      courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p3', 'p4'], teamB: ['p1', 'p2'], startedAt: '2026-09-08T12:00:00.000Z' }],
    }));
    fixture.componentRef.setInput('waiting', [{ id: 'p9', name: 'ว่าง' }]);
    fixture.detectChanges();
    click('.lq-add');
    click('.is-editing .lq-seat');
    const chips = Array.from(el().querySelectorAll('.lq-picker .chip-pick')).map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['ว่าง', 'โอ กำลังเล่น', 'นัท กำลังเล่น', 'ตั้ม กำลังเล่น', 'เบส กำลังเล่น']);
  });

  it('deleting a saved lineup is immediate', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: [null, null], blocked: [] }],
    }));
    click('.lq-tool.is-delete');
    const req = http.expectOne(`${B}/sessions/sess1/queue/q1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });
});
