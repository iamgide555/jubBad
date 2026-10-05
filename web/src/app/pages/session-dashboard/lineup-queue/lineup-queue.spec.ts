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

  it('shows saved lineups in order with open seats marked', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: ['p4', null], blocked: [] }],
    }));
    const seats = Array.from(el().querySelectorAll('.lq-seat')).map((b) => b.textContent?.trim());
    expect(seats).toEqual(['โอ', 'ให้ระบบเลือก', 'นัท', 'ให้ระบบเลือก']);
  });

  it('flags a seated player who is resting', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', null], teamB: [null, null], blocked: [{ playerId: 'p3', reason: 'resting' }] }],
    }));
    expect(el().querySelector('.lq-seat.is-blocked')).toBeTruthy();
    expect(el().querySelector('.lq-flag')?.textContent?.trim()).toBe('พัก');
  });

  it('builds a lineup from the draft and saves it on the first player picked', async () => {
    await load(session());
    (el().querySelector('.lq-add') as HTMLButtonElement).click();
    fixture.detectChanges();
    (el().querySelector('.is-draft .lq-seat') as HTMLButtonElement).click();
    fixture.detectChanges();

    const chips = Array.from(el().querySelectorAll('.lq-picker .chip-pick')).map((b) => b.textContent?.trim());
    expect(chips).toEqual(['ตั้ม', 'เบส', 'ปอ']);

    (el().querySelector('.lq-picker .chip-pick') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/queue`);
    expect(req.request.body).toEqual({ teamA: ['p1', null], teamB: [null, null] });
    req.flush({ ok: true, id: 'q1' });
  });

  it('leaves players already lined up out of the picker', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p1', null], teamB: [null, null], blocked: [] }],
    }));
    (el().querySelectorAll('.lq-entry .lq-seat')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    const chips = Array.from(el().querySelectorAll('.lq-picker .chip-pick')).map((b) => b.textContent?.trim());
    expect(chips).toEqual(['เบส', 'ปอ']);
  });

  it('tapping an occupied seat removes that player, and the last one removes the lineup', async () => {
    await load(session({
      lineupQueue: [{ id: 'q1', position: 0, teamA: ['p3', 'p4'], teamB: [null, null], blocked: [] }],
    }));
    (el().querySelectorAll('.lq-entry .lq-seat')[0] as HTMLButtonElement).click();
    const edit = http.expectOne(`${B}/sessions/sess1/queue/q1`);
    expect(edit.request.method).toBe('POST');
    expect(edit.request.body).toEqual({ teamA: [null, 'p4'], teamB: [null, null] });
    edit.flush({ ok: true });
  });
});
