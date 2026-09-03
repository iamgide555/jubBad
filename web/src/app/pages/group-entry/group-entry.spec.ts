import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';
import { RosterService } from '../../core/roster.service';

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('parsing a roster message switches to the confirm state', () => {
    component.rawText.set(
      '1. ตั้ม\n2. เบส\n19.00-20.00 1 คอร์ท\n@All'
    );
    component.parse();
    expect(component.state()).toBe('confirm');
  });

  it('prefills header fields from the parsed message', () => {
    component.rawText.set(
      '@All แบดวินนิ่ง อังคาร 8/9/26\n19.00-20.00 2 คอร์ท @ KIP\n1. ตั้ม\n2. เบส'
    );
    component.parse();
    expect(component.date()).toBe('2026-09-08');
    expect(component.courtCount()).toBe(2);
    expect(component.venue()).toBe('KIP');
  });

  it('classifies parsed names against known players', () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

    component.rawText.set('1. ตั้ม\n2. เกียร์');
    component.parse();

    expect(component.rosterReviews()[0].match).toEqual({ type: 'exact', playerId: 'p1' });
    expect(component.rosterReviews()[1].match).toEqual({ type: 'new' });
  });

  it('canConfirm is false until date and courtCount are set', () => {
    component.rawText.set('1. ตั้ม');
    component.parse();
    component.date.set('');
    component.courtCount.set(null);
    expect(component.canConfirm()).toBe(false);
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    expect(component.canConfirm()).toBe(true);
  });

  it('toggleDecision flips a fuzzy review between accept and reject-new', () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

    component.rawText.set('1. ตัม');
    component.parse();

    const review = component.rosterReviews()[0];
    expect(review.decision).toBe('accept');
    component.toggleDecision(review);
    expect(component.rosterReviews()[0].decision).toBe('reject-new');
  });

  it('confirmRoster persists players and session, then navigates to the new session', async () => {
    const rosterService = TestBed.inject(RosterService);
    const router = TestBed.inject(Router);

    component.rawText.set('1. ตั้ม\n2. เกียร์');
    component.parse();
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    component.venue.set('KIP');

    component.confirmRoster();
    await fixture.whenStable();

    const players = rosterService.getPlayers('group1');
    expect(players).toHaveLength(2);
    expect(players.map((p) => p.name)).toEqual(['ตั้ม', 'เกียร์']);

    expect(router.url).toMatch(/^\/s\//);
    const sessionCode = router.url.split('/s/')[1];
    const session = rosterService.getSession(sessionCode);
    expect(session).toMatchObject({
      groupCode: 'group1',
      date: '2026-09-08',
      courtCount: 2,
      venue: 'KIP',
    });
    expect(session?.rosterPlayerIds).toHaveLength(2);
  });

  it('groupName is empty when no Group has been saved yet', () => {
    expect(component.groupName()).toBe('');
  });

  it('groupName prefills from a previously saved Group', async () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.saveGroup({ code: 'group1', name: 'Group A' });

    const other = TestBed.createComponent(GroupEntry);
    await other.whenStable();
    expect(other.componentInstance.groupName()).toBe('Group A');
  });

  it('saveGroupName persists the current groupName', () => {
    const rosterService = TestBed.inject(RosterService);
    component.groupName.set('Group A');
    component.saveGroupName();
    expect(rosterService.getGroup('group1')).toEqual({ code: 'group1', name: 'Group A' });
  });
});
