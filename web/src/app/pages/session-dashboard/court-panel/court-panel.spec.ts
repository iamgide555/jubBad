import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CourtPanel } from './court-panel';
import { LiveSessionService } from '../../../core/live-session.service';
import { RosterService } from '../../../core/roster.service';

describe('CourtPanel', () => {
  let fixture: ComponentFixture<CourtPanel>;
  let service: LiveSessionService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    const rosterService = TestBed.inject(RosterService);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      waitlistPlayerIds: [],
    });

    service = TestBed.inject(LiveSessionService);
    fixture = TestBed.createComponent(CourtPanel);
    fixture.componentRef.setInput('courtNumber', 1);
    fixture.componentRef.setInput('players', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p3', name: 'ปอม', aliases: [] },
      { id: 'p4', name: 'ไม้', aliases: [] },
    ]);
    await fixture.whenStable();
  });

  it('shows a "Start next match" button when idle', () => {
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Start next match');
  });

  it('shows reshuffle and confirm controls once pending', () => {
    service.proposeMatch(1, () => 0.5);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('reshuffle');
    expect(text).toContain('confirm');
  });

  it('shows player names, not raw ids, once a pairing is proposed', () => {
    service.proposeMatch(1, () => 0.5);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).not.toContain('p1');
  });

  it('shows a "Finish match" control once active', () => {
    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Finish match');
  });

  it('clicking "Start next match" calls proposeMatch on the service', () => {
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(service.courts()[0].status).toBe('pending');
  });

});

describe('CourtPanel with too few players', () => {
  it('shows a message when there are not enough players to start a match', async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    const rosterService = TestBed.inject(RosterService);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2'],
      waitlistPlayerIds: [],
    });

    const service = TestBed.inject(LiveSessionService);
    const fixture = TestBed.createComponent(CourtPanel);
    fixture.componentRef.setInput('courtNumber', 1);
    fixture.componentRef.setInput('players', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    expect(service.courts()[0]).toEqual({ status: 'idle' });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Not enough players waiting');
  });
});
