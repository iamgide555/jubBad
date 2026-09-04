import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { SessionDisplay } from './session-display';
import { LiveSessionService } from '../../core/live-session.service';
import { RosterService } from '../../core/roster.service';

describe('SessionDisplay', () => {
  let fixture: ComponentFixture<SessionDisplay>;
  let component: SessionDisplay;
  let rosterService: RosterService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    rosterService = TestBed.inject(RosterService);
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
      venue: 'KIP',
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      waitlistPlayerIds: [],
    });
  });

  it('shows the Group name as the header when one is set', async () => {
    rosterService.saveGroup({ code: 'group1', name: 'Group A', lastSessionCode: null });
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.header()).toBe('Group A');
  });

  it('falls back to date + venue when no Group name is set', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.header()).toBe('2026-09-08 · KIP');
  });

  it('shows "waiting" for an idle or pending court, never a proposed pairing', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    liveSession.proposeMatch(1, () => 0.5); // pending, not confirmed

    expect(component.courtLines()[0].text).toBe('waiting');
  });

  it('shows the pairing for an active court', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    liveSession.proposeMatch(1, () => 0.5);
    liveSession.confirmMatch(1);

    const line = component.courtLines()[0];
    expect(line.text).toContain('vs');
    expect(line.text).not.toBe('waiting');
  });

  it('clicking refresh calls liveSession.refresh', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    const spy = vi.spyOn(liveSession, 'refresh');

    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();

    expect(spy).toHaveBeenCalled();
  });

  it('lists waiting players by name', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.waitingNames().sort()).toEqual(['ตั้ม', 'ปอม', 'เบส', 'ไม้'].sort());
  });
});
