import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { PlayerRoster } from './player-roster';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

const PLAYERS = [
  {
    id: 'p1',
    name: 'ตั้ม',
    aliases: [],
    age: 30,
    email: 'tam@example.test',
    phone: '0812345678',
    rating: 1250,
    singlesRating: null,
    winRate: 0.5,
  },
  {
    id: 'p2',
    name: 'มด',
    aliases: [],
    age: null,
    email: null,
    phone: null,
    rating: 1180,
    singlesRating: 1300,
    winRate: null,
  },
];

describe('PlayerRoster', () => {
  let component: PlayerRoster;
  let fixture: ComponentFixture<PlayerRoster>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlayerRoster],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PlayerRoster);
    component = fixture.componentInstance;

    httpMock.expectOne(`${B}/groups/group1/players/manage`).flush(PLAYERS);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => httpMock.verify());

  it('loads and lists players', () => {
    expect(component.players()).toEqual(PLAYERS);
  });

  it('sorts by doubles rating descending by default', () => {
    expect(component.sortedPlayers().map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('sorts nulls last when switching to singlesRating', () => {
    component.setSortKey('singlesRating');
    // p2 has a singlesRating (1300), p1's is null and must sort last.
    expect(component.sortedPlayers().map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('starts an edit prefilled with the player row, submitting an update', async () => {
    component.startEdit(PLAYERS[0]);
    expect(component.editName()).toBe('ตั้ม');
    expect(component.editAge()).toBe('30');

    component.editName.set('ตั้ม2');
    const savePromise = component.saveEdit(PLAYERS[0]);

    const req = httpMock.expectOne(`${B}/groups/group1/players/p1`);
    expect(req.request.body).toEqual({
      name: 'ตั้ม2',
      age: 30,
      email: 'tam@example.test',
      phone: '0812345678',
    });
    req.flush({ id: 'p1', name: 'ตั้ม2', aliases: [], age: 30, email: 'tam@example.test', phone: '0812345678' });
    await savePromise;

    expect(component.editingId()).toBeNull();
    expect(component.players().find((p) => p.id === 'p1')?.name).toBe('ตั้ม2');
  });

  it('rejects an out-of-range age client-side without calling the server', async () => {
    component.startEdit(PLAYERS[0]);
    component.editAge.set('999');
    await component.saveEdit(PLAYERS[0]);

    expect(component.editError()).toBeTruthy();
    httpMock.expectNone(`${B}/groups/group1/players/p1`);
  });

  it('cancelEdit clears the editing state', () => {
    component.startEdit(PLAYERS[0]);
    component.cancelEdit();
    expect(component.editingId()).toBeNull();
  });

  it('disables other rows’ edit buttons while one row is being edited', () => {
    component.startEdit(PLAYERS[0]);
    fixture.detectChanges();

    const editButtons = [...fixture.nativeElement.querySelectorAll('button')].filter(
      (b: HTMLButtonElement) => b.textContent?.trim() === 'แก้ไข'
    ) as HTMLButtonElement[];
    // p1 is mid-edit (its row renders the edit form instead), so the only
    // remaining "แก้ไข" button belongs to p2 — and must be disabled.
    expect(editButtons.length).toBe(1);
    expect(editButtons[0].disabled).toBe(true);
  });

  it('re-enables edit buttons once editing ends', () => {
    component.startEdit(PLAYERS[0]);
    fixture.detectChanges();
    component.cancelEdit();
    fixture.detectChanges();

    const editButtons = [...fixture.nativeElement.querySelectorAll('button')].filter(
      (b: HTMLButtonElement) => b.textContent?.trim() === 'แก้ไข'
    ) as HTMLButtonElement[];
    expect(editButtons.every((b) => !b.disabled)).toBe(true);
  });

  it('replaces the back link with a non-navigable indicator while editing', () => {
    expect(fixture.nativeElement.querySelector('a[href="/g/group1"]')).toBeTruthy();

    component.startEdit(PLAYERS[0]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('a[href="/g/group1"]')).toBeNull();

    component.cancelEdit();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('a[href="/g/group1"]')).toBeTruthy();
  });

  it('canDeactivate allows navigation with no open edit, without prompting', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    expect(component.canDeactivate()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('canDeactivate prompts and honors the answer when an edit is open', () => {
    component.startEdit(PLAYERS[0]);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(component.canDeactivate()).toBe(false);

    confirmSpy.mockReturnValue(true);
    expect(component.canDeactivate()).toBe(true);
    confirmSpy.mockRestore();
  });

  it('prevents beforeunload only while an edit is open', () => {
    const idleEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idleEvent);
    expect(idleEvent.defaultPrevented).toBe(false);

    component.startEdit(PLAYERS[0]);
    const editingEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(editingEvent);
    expect(editingEvent.defaultPrevented).toBe(true);

    component.cancelEdit();
    const afterCancelEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterCancelEvent);
    expect(afterCancelEvent.defaultPrevented).toBe(false);
  });

  it('removes the beforeunload listener on destroy', () => {
    component.startEdit(PLAYERS[0]);
    fixture.destroy();

    const eventAfterDestroy = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(eventAfterDestroy);
    expect(eventAfterDestroy.defaultPrevented).toBe(false);
  });
});
