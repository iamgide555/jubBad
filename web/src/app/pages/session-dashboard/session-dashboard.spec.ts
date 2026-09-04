import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { RosterService } from '../../core/roster.service';

describe('SessionDashboard', () => {
  let component: SessionDashboard;
  let fixture: ComponentFixture<SessionDashboard>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SessionDashboard],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) },
          },
        },
      ],
    }).compileComponents();
  });

  it('renders the confirmed roster as chips', async () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
    ]);
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

    fixture = TestBed.createComponent(SessionDashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();

    expect(component.rosterNames()).toEqual(['ตั้ม', 'เบส']);

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).toContain('เบส');
  });

  it('renders one CourtPanel per court', () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p3', name: 'ปอม', aliases: [] },
      { id: 'p4', name: 'ไม้', aliases: [] },
    ]);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 2,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      waitlistPlayerIds: [],
    });

    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    const panels = (fixture.nativeElement as HTMLElement).querySelectorAll('app-court-panel');
    expect(panels).toHaveLength(2);
  });

  it('renders the waiting queue', () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p3', name: 'ปอม', aliases: [] },
      { id: 'p4', name: 'ไม้', aliases: [] },
    ]);
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

    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    const waitingSection = (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue');
    expect(waitingSection).toBeTruthy();
    expect(waitingSection?.textContent).toContain('ตั้ม');
  });

  it('renders the waitlist as chips', () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
    ]);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1'],
      waitlistPlayerIds: ['p2'],
    });

    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    const waitlistSection = (fixture.nativeElement as HTMLElement).querySelector('.waitlist');
    expect(waitlistSection).toBeTruthy();
    expect(waitlistSection?.textContent).toContain('เบส');
  });

  it('shows a "session not found" message for an unknown sessionCode', () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session not found');
  });
});
