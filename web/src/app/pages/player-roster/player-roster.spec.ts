import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { PlayerRoster } from './player-roster';
import { standardLadderFixture } from '../../core/group-levels.testing';
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
    level: null,
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
    level: 'P' as const,
    rating: 1180,
    singlesRating: 1300,
    winRate: null,
  },
];

// jsdom implements no showModal()/close() on <dialog>; the shared add-rule
// modal needs them. Guarded so a future jsdom that implements them takes over.
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
    httpMock.expectOne(`${B}/groups/group1/rules`).flush([]);
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    // The page reads the group's ladder for its level pickers; most tests are not about it.
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    httpMock.verify();
  });

  it('loads and lists players', () => {
    expect(component.players()).toEqual(PLAYERS);
  });

  it('copies the player profile link from the row button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-share-player]')!;
      btn.click();
      await fixture.whenStable();
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText.mock.calls[0][0]).toMatch(new RegExp(`/g/group1/p/${PLAYERS[0].id}$`));
      expect(component.sharedPlayerId()).toBe(PLAYERS[0].id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the link for manual copy when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } });
    try {
      await component.sharePlayer('p1');
      expect(component.shareFailed()).toBe(true);
      expect(component.clipboardFallback()).toMatch(/\/g\/group1\/p\/p1$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves a level change immediately, without entering edit mode, then reloads ratings', async () => {
    const savePromise = component.setLevel(PLAYERS[0], 'P+');
    const put = httpMock.expectOne(`${B}/groups/group1/players/p1/level`);
    // The choice travels with the ladder revision the host picked it from.
    expect(put.request.body).toEqual({ level: 'P+', expectedLadderRevision: 0 });
    put.flush({ id: 'p1', level: 'P+' });
    // The level reset the player's rating seed, so every row's rating may
    // have shifted — the whole list is refetched rather than patching just
    // the level field. Let the PUT's .then() run before the reload GET
    // is issued.
    await Promise.resolve();
    httpMock
      .expectOne(`${B}/groups/group1/players/manage`)
      .flush([{ ...PLAYERS[0], level: 'P+', rating: 1350 }, PLAYERS[1]]);
    await savePromise;

    const p1 = component.players().find((p) => p.id === 'p1');
    expect(p1?.level).toBe('P+');
    expect(p1?.rating).toBe(1350);
  });

  it('rolls back an optimistic level change if the save fails', async () => {
    const savePromise = component.setLevel(PLAYERS[0], 'P+');
    httpMock
      .expectOne(`${B}/groups/group1/players/p1/level`)
      .error(new ProgressEvent('error'));
    // A failed save also rereads the ladder, so the next choice is made from the current one.
    await Promise.resolve();
    await Promise.resolve();
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
    await savePromise;

    expect(component.players().find((p) => p.id === 'p1')?.level).toBeNull();
    expect(component.levelSaveError()).not.toBeNull();
  });

  it('sorts by level descending, nulls (no level yet) last', () => {
    component.setSortKey('level');
    // p2 is 'P', p1 has no level and must sort last.
    expect(component.sortedPlayers().map((p) => p.id)).toEqual(['p2', 'p1']);
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

  describe('pair rules', () => {
    const rule = (id: string, kind: 'must-pair' | 'never-teammates' | 'never-same-court') => ({
      id,
      groupId: 'group1',
      playerAId: 'p1',
      playerBId: 'p2',
      kind,
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    const el = () => fixture.nativeElement as HTMLElement;
    const rows = () => [...el().querySelectorAll<HTMLElement>('.rule-row')];

    it('renders each rule with its Thai kind label and both player names', async () => {
      component.rules.set([rule('r1', 'must-pair'), rule('r2', 'never-teammates'), rule('r3', 'never-same-court')]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const selected = rows().map((r) => r.querySelector('select')!.selectedOptions[0].textContent!.trim());
      expect(selected).toEqual(['คู่กัน', 'ห้ามอยู่ด้วยกัน', 'ห้ามเล่นด้วยกัน']);
      expect(rows()[0].textContent).toContain('ตั้ม');
      expect(rows()[0].textContent).toContain('มด');
    });

    it('uses native, keyboard-reachable controls for every rule action', () => {
      component.rules.set([rule('r1', 'must-pair')]);
      fixture.detectChanges();
      const row = rows()[0];
      expect(row.querySelector('select')).not.toBeNull();
      expect(row.querySelector('button')?.getAttribute('type')).toBe('button');
      expect(el().querySelector('[data-add-rule]')?.getAttribute('type')).toBe('button');
    });

    it('keeps the rules above the player table, collapsed, with their count', () => {
      component.rules.set([rule('r1', 'must-pair'), rule('r2', 'never-teammates')]);
      fixture.detectChanges();
      const details = el().querySelector('details.pair-rules') as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')!.textContent).toContain('(2)');
      const table = el().querySelector('.table-scroll')!;
      expect(details.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('no longer has an inline rule form at the bottom of the page', () => {
      expect(el().querySelector('.rule-form')).toBeNull();
    });

    describe('adding a rule from the shared modal', () => {
      const dialog = () => el().querySelector('dialog.add-rule-dialog') as HTMLDialogElement;
      const tapPlayer = (id: string) => {
        (dialog().querySelector(`[data-player-chip="${id}"]`) as HTMLButtonElement).click();
        fixture.detectChanges();
      };
      async function openAndPick(): Promise<void> {
        (el().querySelector('[data-add-rule]') as HTMLButtonElement).click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        tapPlayer('p1');
        tapPlayer('p2');
      }
      const submit = () => (dialog().querySelector('[data-submit-rule]') as HTMLButtonElement).click();

      it('opens the shared modal listing the whole group', async () => {
        await openAndPick();
        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().querySelectorAll('[data-player-chip]').length).toBe(component.players().length);
      });

      it('creates a persistent rule, opens the list on it, and closes the modal', async () => {
        await openAndPick();
        (dialog().querySelector('input[type="radio"][value="never-teammates"]') as HTMLInputElement).click();
        fixture.detectChanges();
        submit();
        const req = httpMock.expectOne(`${B}/groups/group1/rules`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ playerAId: 'p1', playerBId: 'p2', kind: 'never-teammates' });
        req.flush(rule('r9', 'never-teammates'));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(component.rules().map((r) => r.id)).toEqual(['r9']);
        expect(component.rulesOpen()).toBe(true);
        expect(dialog().hasAttribute('open')).toBe(false);
      });

      it('shows a duplicate-pair refusal inside the modal and keeps the picks', async () => {
        await openAndPick();
        submit();
        httpMock
          .expectOne(`${B}/groups/group1/rules`)
          .flush({ code: 'PAIR_RULE_EXISTS' }, { status: 409, statusText: 'Conflict' });
        await fixture.whenStable();
        fixture.detectChanges();
        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().textContent).toContain('ผู้เล่นคู่นี้มีกฎอยู่แล้ว');
        expect(dialog().querySelectorAll('[data-player-chip][aria-pressed="true"]').length).toBe(2);
        expect(component.rules()).toEqual([]);
      });

      it('explains a second required partner as a conflict', async () => {
        await openAndPick();
        submit();
        httpMock
          .expectOne(`${B}/groups/group1/rules`)
          .flush({ code: 'PAIR_RULE_MUST_PAIR_TAKEN' }, { status: 409, statusText: 'Conflict' });
        await fixture.whenStable();
        fixture.detectChanges();
        expect(dialog().textContent).toContain('ผู้เล่นคนนี้มีคู่กันอยู่แล้ว');
      });
    });

    it('switches a rule kind, and rolls back with a message when refused', async () => {
      component.rules.set([rule('r1', 'never-teammates')]);
      const ok = component.setRuleKind(component.rules()[0], 'never-same-court');
      const put = httpMock.expectOne(`${B}/groups/group1/rules/r1`);
      expect(put.request.body).toEqual({ kind: 'never-same-court' });
      put.flush(rule('r1', 'never-same-court'));
      await ok;
      expect(component.rules()[0].kind).toBe('never-same-court');

      const refused = component.setRuleKind(component.rules()[0], 'must-pair');
      httpMock
        .expectOne(`${B}/groups/group1/rules/r1`)
        .flush({ code: 'PAIR_RULE_MUST_PAIR_TAKEN' }, { status: 409, statusText: 'Conflict' });
      await refused;
      expect(component.rules()[0].kind).toBe('never-same-court');
      expect(component.rulesError()).toBe('ผู้เล่นคนนี้มีคู่กันอยู่แล้ว');
    });

    it('removes a rule', async () => {
      component.rules.set([rule('r1', 'must-pair')]);
      const done = component.deleteRule(component.rules()[0]);
      const req = httpMock.expectOne(`${B}/groups/group1/rules/r1`);
      expect(req.request.method).toBe('DELETE');
      req.flush({ deleted: true });
      await done;
      expect(component.rules()).toEqual([]);
    });
  });

  describe('group ladders (host feedback F)', () => {
    const custom = {
      mode: 'custom' as const,
      revision: 4,
      levels: [{ id: 'x', name: 'มือใหม่', startingElo: 1000 }, { id: 'y', name: 'กลาง', startingElo: 1200 }, { id: 'z', name: 'เก่ง', startingElo: 1400 }],
      assignedCounts: { x: 0, y: 0, z: 0 },
    };
    const trigger = () => (fixture.nativeElement as HTMLElement).querySelector('app-level-picker .level-trigger') as HTMLButtonElement;

    it('each row offers this group\'s own level names, never the built-in ones', () => {
      component.ladder.set(custom);
      fixture.detectChanges();
      trigger().click();
      fixture.detectChanges();
      const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-level-picker .chip')].map((b) => b.textContent!.trim());
      expect(chips.slice(0, 4)).toEqual(['-', 'มือใหม่', 'กลาง', 'เก่ง']);
      expect(chips).not.toContain('BG');
    });

    it('sorting by level follows the group\'s order, highest first, untagged last', () => {
      component.ladder.set(custom);
      component.players.set([
        { ...PLAYERS[0], id: 'a', level: 'กลาง' },
        { ...PLAYERS[0], id: 'b', level: 'เก่ง' },
        { ...PLAYERS[0], id: 'c', level: null },
        { ...PLAYERS[0], id: 'd', level: 'มือใหม่' },
      ]);
      component.setSortKey('level');
      expect(component.sortedPlayers().map((p) => p.id)).toEqual(['b', 'a', 'd', 'c']);
    });

    it('a stale revision is shown to the host, the chip rolls back, and the ladder is read again', async () => {
      component.ladder.set(custom);
      const save = component.setLevel(PLAYERS[0], 'กลาง');
      httpMock.expectOne(`${B}/groups/group1/players/p1/level`).flush({ code: 'LEVEL_LADDER_STALE' }, { status: 409, statusText: 'Conflict' });
      await Promise.resolve();
      await Promise.resolve();
      const reread = httpMock.expectOne(`${B}/groups/group1/levels`);
      reread.flush({ ...custom, revision: 5 });
      await save;
      expect(component.levelSaveError()).toContain('มีการแก้ระดับ');
      expect(component.players().find((p) => p.id === 'p1')?.level).toBeNull();
      expect(component.ladder()?.revision).toBe(5);
    });

    it('when the ladder cannot be read the level choices are disabled, not guessed', () => {
      component.ladder.set(null);
      fixture.detectChanges();
      expect(trigger().disabled).toBe(true);
    });
  });

  describe('bulk level tagging', () => {
    const custom = {
      mode: 'custom' as const, revision: 3,
      levels: [{ id: 'x', name: 'มือใหม่', startingElo: 1000 }, { id: 'y', name: 'เก่ง', startingElo: 1400 }],
      assignedCounts: { x: 0, y: 0 },
    };
    const el = () => fixture.nativeElement as HTMLElement;
    const apply = () => [...el().querySelectorAll<HTMLButtonElement>('[data-bulk-apply]')];

    it('shows a toggle once the ladder is read, and the level chips only while bulk is on', () => {
      component.ladder.set(custom);
      fixture.detectChanges();
      expect(el().querySelector('[data-bulk-toggle]')).toBeTruthy();
      expect(el().querySelector('[data-bulk-level]')).toBeNull();
      (el().querySelector('[data-bulk-toggle]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect([...el().querySelectorAll('[data-bulk-level]')].map((b) => b.textContent!.trim())).toEqual(['ล้างระดับ', 'มือใหม่', 'เก่ง']);
    });

    it('names do nothing until a level is picked; then each tap sends one write with the revision and no list reload', async () => {
      component.ladder.set(custom);
      await component.toggleBulk();
      fixture.detectChanges();
      expect(apply().every((b) => b.disabled)).toBe(true);
      component.pickBulkLevel('เก่ง');
      fixture.detectChanges();
      apply()[0].click();
      const put = httpMock.expectOne(`${B}/groups/group1/players/${PLAYERS[0].id}/level`);
      expect(put.request.body).toEqual({ level: 'เก่ง', expectedLadderRevision: 3 });
      put.flush({ id: PLAYERS[0].id, level: 'เก่ง' });
      await Promise.resolve();
      httpMock.expectNone(`${B}/groups/group1/players/manage`);
      expect(component.players().find((p) => p.id === PLAYERS[0].id)?.level).toBe('เก่ง');
    });

    it('tapping a player who already has that level sends nothing', async () => {
      component.ladder.set(custom);
      await component.toggleBulk();
      component.pickBulkLevel('P' as never);
      await component.bulkApply(PLAYERS[1]); // PLAYERS[1] is already 'P'
      httpMock.expectNone(`${B}/groups/group1/players/${PLAYERS[1].id}/level`);
    });

    it('"clear" removes a level, and finishing refreshes the ratings once', async () => {
      component.ladder.set(custom);
      await component.toggleBulk();
      component.pickBulkLevel(null);
      const save = component.bulkApply(PLAYERS[1]);
      const put = httpMock.expectOne(`${B}/groups/group1/players/${PLAYERS[1].id}/level`);
      expect(put.request.body).toEqual({ level: null, expectedLadderRevision: 3 });
      put.flush({ id: PLAYERS[1].id, level: null });
      await save;
      const done = component.toggleBulk();
      httpMock.expectOne(`${B}/groups/group1/players/manage`).flush(PLAYERS);
      await done;
      expect(component.bulkOn()).toBe(false);
      expect(component.bulkLevel()).toBeUndefined();
    });

    it('without a readable ladder there is no bulk control at all', () => {
      component.ladder.set(null);
      fixture.detectChanges();
      expect(el().querySelector('[data-bulk]')).toBeNull();
    });
  });
});
