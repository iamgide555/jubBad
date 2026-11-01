import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import type { LineAccountRow } from '../../core/line-accounts.service';
import type { ManagedPlayer } from '../../core/roster.service';
import { LineAccounts } from './line-accounts';

const B = environment.apiBaseUrl;
const LIST_URL = `${B}/groups/g1/line/accounts`;
const PLAYERS_URL = `${B}/groups/g1/players/manage`;

// jsdom implements no showModal()/close() on <dialog>. Guarded so a future jsdom that implements them takes over.
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

const row = (
  id: string,
  displayName: string | null,
  player: LineAccountRow['player'] = null,
  source: LineAccountRow['source'] = 'roster'
): LineAccountRow => ({
  id,
  displayName,
  pictureUrl: null,
  source,
  firstSeenAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-20T10:00:00.000Z',
  player,
});

const player = (
  id: string,
  name: string,
  lineAccount: ManagedPlayer['lineAccount'] = null
): ManagedPlayer => ({
  id,
  name,
  aliases: [],
  age: null,
  email: null,
  phone: null,
  level: null,
  rating: null,
  singlesRating: null,
  winRate: null,
  lineAccount,
});

const ACCOUNTS: LineAccountRow[] = [
  row('a1', 'Tam LINE'),
  row('a2', 'Mod LINE', { id: 'p2', name: 'มด', linkedBy: 'host' }, 'slip'),
  row('a3', null, { id: 'p3', name: 'นุ่น', linkedBy: 'self' }, 'claim'),
];

describe('LineAccounts', () => {
  let fixture: ComponentFixture<LineAccounts>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const qa = (sel: string) => [...el().querySelectorAll<HTMLElement>(sel)];
  const q = <T extends HTMLElement>(sel: string) => el().querySelector(sel) as T;
  const rowIds = () => qa('[data-account-row]').map((r) => r.getAttribute('data-account-row'));
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LineAccounts],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'g1' }) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LineAccounts);
  });
  afterEach(() => http.verify());

  async function load(accounts: LineAccountRow[] = ACCOUNTS) {
    fixture.detectChanges();
    http.expectOne(LIST_URL).flush(accounts);
    await settle();
  }

  it('lists every account with avatar, name, last seen and its linked player', async () => {
    await load();
    expect(rowIds()).toEqual(['a1', 'a2', 'a3']);
    const [a1, a2, a3] = qa('[data-account-row]');
    for (const r of [a1, a2, a3]) {
      expect(r.querySelector('app-line-avatar')).not.toBeNull();
      expect(r.querySelector('.seen')!.textContent).toContain('เห็นล่าสุด');
    }
    expect(a1.querySelector('.name')!.textContent!.trim()).toBe('Tam LINE');
    expect(a1.querySelector('[data-linked-player]')).toBeNull();
    expect(a1.querySelector('.source')!.textContent!.trim()).toBe('รายชื่อ');
    expect(a2.querySelector('[data-linked-player]')!.textContent).toContain('มด');
    expect(a2.querySelector('.source')!.textContent!.trim()).toBe('สลิป');
    expect(a2.querySelector('[data-linked-by]')!.textContent!.trim()).toBe('ผู้จัดผูก');
    expect(a3.querySelector('.name')!.textContent!.trim()).toBe('ไม่ทราบชื่อ');
    expect(a3.querySelector('[data-linked-player]')!.textContent).toContain('นุ่น');
    expect(a3.querySelector('.source')!.textContent!.trim()).toBe('ผู้เล่นยืนยัน');
    expect(a3.querySelector('[data-linked-by]')!.textContent!.trim()).toBe('ผู้เล่นผูกเอง');
    // Unlinked rows offer "link", linked rows offer "unlink".
    expect(a1.querySelector('[data-link-player]')).not.toBeNull();
    expect(a1.querySelector('[data-unlink]')).toBeNull();
    expect(a2.querySelector('[data-unlink]')).not.toBeNull();
    expect(a2.querySelector('[data-link-player]')).toBeNull();
  });

  it('shows the host source label too', async () => {
    await load([row('a1', 'Tam', null, 'host')]);
    expect(q('.source').textContent!.trim()).toBe('ผู้จัด');
  });

  it('the ยังไม่ผูก filter shows only unlinked accounts', async () => {
    await load();
    const tabs = qa('[data-filter]');
    expect(tabs.map((t) => t.getAttribute('data-filter'))).toEqual(['all', 'unlinked']);
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
    tabs[1].click();
    fixture.detectChanges();
    expect(rowIds()).toEqual(['a1']);
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    tabs[0].click();
    fixture.detectChanges();
    expect(rowIds()).toEqual(['a1', 'a2', 'a3']);
  });

  it('says so when every account is linked and the filter is ยังไม่ผูก', async () => {
    await load([row('a2', 'Mod', { id: 'p2', name: 'มด', linkedBy: 'host' })]);
    q('[data-filter="unlinked"]').click();
    fixture.detectChanges();
    expect(rowIds()).toEqual([]);
    expect(q('[data-no-unlinked]').textContent).toContain('ยังไม่มีบัญชี LINE ที่ยังไม่ได้ผูก');
  });

  it('unlink keeps the row, now unlinked', async () => {
    await load();
    q('[data-account-row="a2"] [data-unlink]').click();
    const req = http.expectOne(`${LIST_URL}/a2/player`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
    await settle();
    expect(rowIds()).toEqual(['a1', 'a2', 'a3']);
    const a2 = q('[data-account-row="a2"]');
    expect(a2.querySelector('[data-linked-player]')).toBeNull();
    expect(a2.querySelector('[data-unlink]')).toBeNull();
    expect(a2.querySelector('[data-link-player]')).not.toBeNull();
  });

  it('a failed unlink leaves the row linked and shows an error', async () => {
    await load();
    q('[data-account-row="a2"] [data-unlink]').click();
    http.expectOne(`${LIST_URL}/a2/player`).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(q('[data-account-row="a2"] [data-linked-player]')).not.toBeNull();
    expect(q('[data-error]').textContent).toContain('บันทึกไม่สำเร็จ');
  });

  it('ผูกกับผู้เล่น opens a player picker listing players without a LINE link first, and linking updates the row', async () => {
    await load();
    q('[data-account-row="a1"] [data-link-player]').click();
    http
      .expectOne(PLAYERS_URL)
      .flush([
        player('p2', 'มด', { id: 'a2', displayName: 'Mod LINE', pictureUrl: null, linkedBy: 'host' }),
        player('p1', 'ตั้ม'),
        player('p4', 'บี'),
      ]);
    await settle();
    const dialog = q<HTMLDialogElement>('dialog');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(qa('[data-pick-player]').map((b) => b.getAttribute('data-pick-player'))).toEqual(['p1', 'p4', 'p2']);
    // A player who already has an account says which, since choosing them replaces it.
    expect(q('[data-pick-player="p2"]').textContent).toContain('Mod LINE');
    expect(q('[data-pick-player="p1"]').textContent).not.toContain('LINE');

    q('[data-pick-player="p1"]').click();
    const req = http.expectOne(`${LIST_URL}/a1/player`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ playerId: 'p1' });
    req.flush({ ok: true });
    await settle();

    expect(dialog.hasAttribute('open')).toBe(false);
    const a1 = q('[data-account-row="a1"]');
    expect(a1.querySelector('[data-linked-player]')!.textContent).toContain('ตั้ม');
    expect(a1.querySelector('[data-linked-by]')!.textContent!.trim()).toBe('ผู้จัดผูก');
    expect(a1.querySelector('[data-unlink]')).not.toBeNull();
  });

  it('linking a player who already had an account frees that account locally', async () => {
    await load([row('a1', 'Tam LINE'), row('a2', 'Mod LINE', { id: 'p2', name: 'มด', linkedBy: 'host' })]);
    q('[data-account-row="a1"] [data-link-player]').click();
    http.expectOne(PLAYERS_URL).flush([
      player('p2', 'มด', { id: 'a2', displayName: 'Mod LINE', pictureUrl: null, linkedBy: 'host' }),
    ]);
    await settle();
    q('[data-pick-player="p2"]').click();
    http.expectOne(`${LIST_URL}/a1/player`).flush({ ok: true });
    await settle();
    expect(q('[data-account-row="a1"] [data-linked-player]').textContent).toContain('มด');
    expect(q('[data-account-row="a2"] [data-linked-player]')).toBeNull();
    expect(q('[data-account-row="a2"] [data-link-player]')).not.toBeNull();
  });

  it('reads the player list once, the first time a picker opens, and keeps it current', async () => {
    await load([row('a1', 'Tam LINE'), row('a2', 'Mod LINE')]);
    q('[data-account-row="a1"] [data-link-player]').click();
    http.expectOne(PLAYERS_URL).flush([player('p1', 'ตั้ม'), player('p4', 'บี')]);
    await settle();
    q('[data-pick-player="p1"]').click();
    http.expectOne(`${LIST_URL}/a1/player`).flush({ ok: true });
    await settle();
    q('[data-account-row="a2"] [data-link-player]').click();
    await settle();
    // No second read; ตั้ม now shows as holding an account, so บี comes first.
    expect(qa('[data-pick-player]').map((b) => b.getAttribute('data-pick-player'))).toEqual(['p4', 'p1']);
  });

  it('a 409 shows the already-linked message and leaves the row unchanged', async () => {
    await load();
    q('[data-account-row="a1"] [data-link-player]').click();
    http.expectOne(PLAYERS_URL).flush([player('p1', 'ตั้ม')]);
    await settle();
    q('[data-pick-player="p1"]').click();
    http
      .expectOne(`${LIST_URL}/a1/player`)
      .flush({ code: 'ACCOUNT_ALREADY_LINKED' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(q('[data-error]').textContent).toContain('บัญชีนี้ผูกกับผู้เล่นคนอื่นแล้ว');
    expect(q('[data-account-row="a1"] [data-linked-player]')).toBeNull();
  });

  it('a failed player list shows an error and opens nothing', async () => {
    await load();
    q('[data-account-row="a1"] [data-link-player]').click();
    http.expectOne(PLAYERS_URL).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(q('[data-error]').textContent).toContain('โหลดรายชื่อผู้เล่นไม่สำเร็จ');
    expect(q<HTMLDialogElement>('dialog').hasAttribute('open')).toBe(false);
  });

  it('disables every link and unlink action while one request is in flight, then clears the error on the next action', async () => {
    await load();
    q('[data-account-row="a2"] [data-unlink]').click();
    fixture.detectChanges();
    const actions = qa('[data-unlink], [data-link-player]') as HTMLButtonElement[];
    expect(actions.length).toBe(3);
    expect(actions.every((b) => b.disabled)).toBe(true);
    http.expectOne(`${LIST_URL}/a2/player`).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect((qa('[data-unlink], [data-link-player]') as HTMLButtonElement[]).every((b) => !b.disabled)).toBe(true);
    expect(q('[data-error]')).not.toBeNull();

    q('[data-account-row="a3"] [data-unlink]').click();
    fixture.detectChanges();
    expect(el().querySelector('[data-error]')).toBeNull();
    http.expectOne(`${LIST_URL}/a3/player`).flush({ ok: true });
    await settle();
  });

  it('clears the error when the filter changes', async () => {
    await load();
    q('[data-account-row="a2"] [data-unlink]').click();
    http.expectOne(`${LIST_URL}/a2/player`).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(q('[data-error]')).not.toBeNull();
    q('[data-filter="unlinked"]').click();
    fixture.detectChanges();
    expect(el().querySelector('[data-error]')).toBeNull();
  });

  it('gives each action a name that says whose account it is', async () => {
    await load();
    expect(q('[data-account-row="a1"] [data-link-player]').getAttribute('aria-label')).toBe('ผูก Tam LINE กับผู้เล่น');
    expect(q('[data-account-row="a2"] [data-unlink]').getAttribute('aria-label')).toBe('ยกเลิกการผูก LINE ของ มด');
  });

  it('labels the player picker dialog by its heading', async () => {
    await load();
    q('[data-account-row="a1"] [data-link-player]').click();
    http.expectOne(PLAYERS_URL).flush([player('p1', 'ตั้ม')]);
    await settle();
    const dialog = q<HTMLDialogElement>('dialog');
    const heading = el().querySelector(`#${dialog.getAttribute('aria-labelledby')}`);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain('เลือกผู้เล่น');
  });

  it('empty state explains roster posts, slips and the pay page', async () => {
    await load([]);
    expect(rowIds()).toEqual([]);
    const empty = q('[data-empty]').textContent!;
    expect(empty).toContain('บัญชีจะขึ้นที่นี่เมื่อมีคนส่งรายชื่อในกลุ่ม LINE ส่งสลิป หรือกดยืนยันตัวเองในหน้าจ่ายเงิน');
  });

  it('shows an error when the list cannot be read', async () => {
    fixture.detectChanges();
    http.expectOne(LIST_URL).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(q('[data-load-error]').textContent).toContain('โหลดบัญชี LINE ไม่สำเร็จ');
    expect(el().querySelector('[data-empty]')).toBeNull();
  });

  it('back link returns to the roster page', async () => {
    await load();
    const back = q<HTMLAnchorElement>('a.back');
    expect(back.getAttribute('href')).toBe('/g/g1/players');
  });

  it('titles the page', async () => {
    await load();
    expect(q('h1').textContent).toContain('บัญชี LINE ในก๊วน');
  });
});
