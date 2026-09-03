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
});
