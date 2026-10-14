import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupHome } from './group-home';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { GroupSession } from '../../core/group-session.model';
import { formatSessionDate } from '../../core/session-date';

const B = environment.apiBaseUrl;
const tick = () => new Promise<void>((r) => setTimeout(r));
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

// An ended session: its state never depends on the day the suite runs.
const SESSION: GroupSession = {
  code: 's1',
  date: '2026-10-11',
  venue: null,
  courtCount: 2,
  createdAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T15:00:00.000Z',
  matchCount: 22,
};
// Not ended and dated today: live.
const LIVE: GroupSession = { ...SESSION, endedAt: null, date: localIso(new Date()), createdAt: new Date().toISOString() };
// Not ended but dated five days ago: left open, not live.
const OPEN: GroupSession = {
  ...SESSION,
  endedAt: null,
  date: localIso(daysAgo(5)),
  createdAt: daysAgo(5).toISOString(),
};

describe('GroupHome', () => {
  let httpMock: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => httpMock.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const trigger = () => el().querySelector<HTMLButtonElement>('[data-settings-trigger]')!;
  const list = () => el().querySelector<HTMLElement>('#group-settings')!;
  // The page formats with the app's own locale: ask the same injector, not a guess.
  const dateLabel = (iso: string) => formatSessionDate(iso, TestBed.inject(LOCALE_ID));

  // The load finishes in promise continuations: let them run, then render the result.
  async function settle() {
    await harness.fixture.whenStable();
    await tick();
    harness.detectChanges();
    await harness.fixture.whenStable();
  }

  async function open(url = '/g/group1', opts: { lastSessionCode?: string | null; sessions?: GroupSession[] } = {}) {
    const page = await harness.navigateByUrl(url, GroupHome);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: opts.lastSessionCode ?? null });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush(opts.sessions ?? []);
    await settle();
    return page;
  }

  function flushValues(over: { players?: number; custom?: boolean; shared?: boolean; shuttle?: boolean; history?: boolean } = {}) {
    httpMock.expectOne(`${B}/groups/group1/players`).flush(
      Array.from({ length: over.players ?? 0 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, aliases: [] }))
    );
    httpMock.expectOne(`${B}/groups/group1/levels`).flush({
      mode: over.custom ? 'custom' : 'standard',
      revision: 1,
      levels: over.custom
        ? [1, 2, 3, 4, 5].map((n) => ({ id: `l${n}`, name: `L${n}`, startingElo: 1000 + n }))
        : [],
      assignedCounts: {},
    });
    httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: over.shared ? 'tok' : null });
    httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: over.shuttle ?? false });
    httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: over.history ?? false });
  }

  it('shows the saved name with a labelled settings button beside it, closed, and makes no settings request yet', async () => {
    await open();
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนอังคาร');
    expect(trigger().textContent).toContain('ตั้งค่าก๊วน');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe('group-settings');
    expect(list().hidden).toBe(true);
  });

  it('a group without sessions shows the save-confirming hint and เริ่มรอบแรก, with no resume link', async () => {
    await open();
    expect(el().querySelector('[data-hint]')?.textContent).toContain('บันทึกก๊วนแล้ว');
    expect(el().querySelector('[data-start]')?.textContent).toContain('เริ่มรอบแรก');
    expect(el().querySelector('[data-resume]')).toBeNull();
  });

  it('a group with sessions shows the header resume link above settings, เริ่มรอบใหม่ and past sessions, and no hint', async () => {
    await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
    const resume = el().querySelector<HTMLAnchorElement>('[data-resume]')!;
    expect(resume.getAttribute('href')).toBe('/s/s1');
    expect(resume.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el().querySelector('[data-hint]')).toBeNull();
    expect(el().querySelector('[data-start]')?.textContent).toContain('เริ่มรอบใหม่');
    expect(el().textContent).toContain('รอบที่ผ่านมา');
    const row = el().querySelector<HTMLElement>('.session-list li')!;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/s/s1');
    // A friendly date, never the ISO string.
    expect(row.querySelector('a')?.textContent?.trim()).toBe(dateLabel('2026-10-11'));
    expect(row.querySelector('a')?.textContent).not.toContain('2026');
    expect(row.textContent).toContain('22');
    expect(row.textContent).toContain('แมตช์');
    // An ended session carries no state tag at all.
    expect(row.querySelector('.tag')).toBeNull();
  });

  describe('the resume link knows live from open from ended', () => {
    const resume = () => el().querySelector<HTMLAnchorElement>('[data-resume]')!;
    const start = () => el().querySelector<HTMLAnchorElement>('[data-start]')!;

    it('a live session is a card with a green ring, the label, the title and a sub-line, above settings', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [{ ...LIVE, venue: 'KIP' }] });
      const card = resume();
      expect(card.dataset['state']).toBe('live');
      expect(card.getAttribute('href')).toBe('/s/s1');
      expect(card.classList.contains('resume-card')).toBe(true);
      expect(card.classList.contains('ring')).toBe(true);
      expect(card.querySelector('.resume-title')?.textContent?.trim()).toBe('กลับไปรอบที่เล่นอยู่');
      expect(card.querySelector('.resume-label')?.textContent).toContain('กำลังเล่นอยู่');
      expect(card.querySelector('.dot')).not.toBeNull();
      expect(card.querySelector('app-icon')).not.toBeNull();
      const sub = card.querySelector('.resume-sub')!;
      expect(sub.textContent).toContain(dateLabel(LIVE.date!));
      expect(sub.textContent).toContain('KIP');
      expect(sub.textContent).toContain('22');
      expect(sub.textContent).toContain('แมตช์');
      expect(sub.children.length).toBe(3);
      expect(card.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('empty sub-line parts are omitted, not left as stray separators', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [{ ...LIVE, date: null, venue: null }] });
      const sub = resume().querySelector('.resume-sub')!;
      expect(sub.children.length).toBe(1);
      expect(sub.textContent).toContain('22');
    });

    it('a live session makes the start action a ghost link, keeping the label and the link', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [LIVE] });
      expect(start().classList.contains('ghost-start')).toBe(true);
      expect(start().classList.contains('start')).toBe(true);
      expect(start().tagName).toBe('A');
      expect(start().getAttribute('href')).toBe('/g/group1/start');
      expect(start().textContent).toContain('เริ่มรอบใหม่');
    });

    it('an open (stale) session is a card without the ring, without the live claim, and start stays filled', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [OPEN] });
      const card = resume();
      expect(card.dataset['state']).toBe('open');
      expect(card.classList.contains('resume-card')).toBe(true);
      expect(card.classList.contains('ring')).toBe(false);
      expect(card.querySelector('.resume-label')?.textContent).toContain('ยังไม่ปิดรอบ');
      expect(card.querySelector('.resume-title')?.textContent?.trim()).toBe('ดูรอบล่าสุด');
      expect(card.querySelector('.dot')).toBeNull();
      expect(card.textContent).not.toContain('กำลังเล่นอยู่');
      expect(start().classList.contains('ghost-start')).toBe(false);
    });

    it('an ended session is the plain text link with no dot, and start stays filled', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      const link = resume();
      expect(link.dataset['state']).toBe('ended');
      expect(link.getAttribute('href')).toBe('/s/s1');
      expect(link.classList.contains('resume-card')).toBe(false);
      expect(link.textContent).toContain('ดูรอบล่าสุด');
      expect(link.textContent).toContain(dateLabel('2026-10-11'));
      expect(link.querySelector('.dot')).toBeNull();
      expect(start().classList.contains('ghost-start')).toBe(false);
    });

    it('a latest session missing from the list says only กลับไปรอบล่าสุด, with no state claim', async () => {
      await open('/g/group1', { lastSessionCode: 'gone', sessions: [SESSION] });
      const link = resume();
      expect(link.getAttribute('href')).toBe('/s/gone');
      expect(link.dataset['state']).toBe('ended');
      expect(link.textContent?.trim()).toBe('กลับไปรอบล่าสุด');
      expect(link.querySelector('.dot')).toBeNull();
      expect(link.classList.contains('resume-card')).toBe(false);
      expect(start().classList.contains('ghost-start')).toBe(false);
    });
  });

  describe('past session rows', () => {
    const rows = () => [...el().querySelectorAll<HTMLElement>('.session-list li')];

    it('a live session row says กำลังเล่น and has no orange live-tag', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [LIVE] });
      const row = rows()[0];
      expect(row.querySelector('.live-tag')).toBeNull();
      expect(row.querySelector('.tag-live')?.textContent).toContain('กำลังเล่น');
      expect(row.querySelector('.tag-open')).toBeNull();
    });

    it('an open session row says ยังไม่ปิดรอบ, not ยังไม่จบ', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [OPEN] });
      const row = rows()[0];
      expect(row.querySelector('.live-tag')).toBeNull();
      expect(row.querySelector('.tag-open')?.textContent).toContain('ยังไม่ปิดรอบ');
      expect(row.textContent).not.toContain('ยังไม่จบ');
      expect(row.querySelector('.tag-live')).toBeNull();
    });

    it('every row carries the class that holds the tap height, and the date link is a block of its own', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [LIVE, { ...SESSION, code: 's0', date: null }] });
      for (const row of rows()) {
        expect(row.classList.contains('session-row')).toBe(true);
        expect(row.querySelector('a.session-link')).not.toBeNull();
      }
      // A session without a date falls back to its code.
      expect(rows()[1].querySelector('a')?.textContent?.trim()).toBe('s0');
    });

    it('venue and match count are separate elements, so spacing never depends on template whitespace', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [{ ...SESSION, venue: 'KIP' }] });
      const row = rows()[0];
      const parts = [...row.querySelectorAll('.session-meta')].map((e) => e.textContent?.replace(/\s+/g, ' ').trim());
      expect(parts).toEqual(['KIP', '22 แมตช์']);
    });
  });

  it('links back to the group list', async () => {
    await open();
    const back = el().querySelector<HTMLAnchorElement>('a.back')!;
    expect(back.getAttribute('href')).toBe('/');
    expect(back.textContent).toContain('ก๊วนของฉัน');
  });

  it('the start action goes to the roster screen', async () => {
    await open();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const start = el().querySelector<HTMLAnchorElement>('[data-start]')!;
    expect(start.tagName).toBe('A');
    expect(start.getAttribute('href')).toBe('/g/group1/start');
    start.click();
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0].toString()).toBe('/g/group1/start');
  });

  it('opening settings reveals five rows in order, with management last', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(list().hidden).toBe(false);
    const rows = [...list().querySelectorAll<HTMLAnchorElement>('a[data-section]')];
    expect(rows.map((r) => r.dataset['section'])).toEqual(['players', 'levels', 'share', 'advanced', 'manage']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/g/group1/players',
      '/g/group1/levels',
      '/g/group1/settings/share',
      '/g/group1/settings/advanced',
      '/g/group1/settings/manage',
    ]);
    expect(rows[4].textContent).toContain('ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน');
    const titles = ['จัดการผู้เล่น', 'ระดับผู้เล่นของก๊วน', 'แชร์หน้าสรุปก๊วน', 'ตั้งค่าขั้นสูง', 'จัดการก๊วน'];
    rows.forEach((r, i) => {
      const id = r.getAttribute('aria-labelledby')!;
      expect(document.getElementById(id)?.textContent?.trim()).toBe(titles[i]);
    });
  });

  it('the settings wrapper holds two lists: four routine rows, then management alone', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    expect(list().tagName).toBe('DIV');
    const lists = [...list().querySelectorAll<HTMLElement>('ul')];
    expect(lists.length).toBe(2);
    expect(lists.every((ul) => ul.parentElement === list())).toBe(true);
    expect([...lists[0].querySelectorAll<HTMLElement>('a[data-section]')].map((r) => r.dataset['section'])).toEqual([
      'players',
      'levels',
      'share',
      'advanced',
    ]);
    expect([...lists[1].querySelectorAll<HTMLElement>('a[data-section]')].map((r) => r.dataset['section'])).toEqual([
      'manage',
    ]);
    expect(lists[0].getAttribute('aria-label')).toBe('ตัวเลือกของก๊วน');
    expect(lists[1].getAttribute('aria-label')).toBe('จัดการก๊วน');
    expect(lists[1].classList.contains('settings-manage')).toBe(true);
    expect(lists[0].classList.contains('settings-manage')).toBe(false);
    expect(lists[1].querySelector('li.manage')).toBeNull();
  });

  it('rows show live values once loaded', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues({ players: 14, custom: true, shared: true, shuttle: true });
    await settle();
    const value = (s: string) => list().querySelector(`[data-section="${s}"] .value`)?.textContent?.trim();
    expect(value('players')).toBe('14 คน');
    expect(value('levels')).toBe('กำหนดเอง · 5 ระดับ');
    expect(value('share')).toBe('แชร์อยู่');
    expect(value('advanced')).toBe('เปิด 1 จาก 2');
    expect(list().querySelector('[data-section="manage"] .value')).toBeNull();
  });

  it('a failed value fetch leaves only the description — never a guessed value', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    httpMock.expectOne(`${B}/groups/group1/players`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/levels`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/share`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: false });
    httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush('x', { status: 500, statusText: 'x' });
    await settle();
    await tick();
    expect(list().querySelectorAll('.value').length).toBe(0);
    expect(list().querySelector('[data-section="players"]')?.textContent).toContain('รายชื่อและข้อมูลติดต่อของผู้เล่น');
  });

  it('values are fetched once, not on every reopen', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    trigger().click();
    trigger().click();
    await settle();
    // httpMock.verify() in afterEach fails on any second fetch
  });

  it('Escape closes settings and returns focus to the trigger', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    expect(list().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('?settings=<section> reopens settings, focuses that row, then drops the parameter', async () => {
    await open('/g/group1?settings=levels');
    flushValues();
    await settle();
    await tick();
    expect(list().hidden).toBe(false);
    const focused = document.activeElement as HTMLElement;
    expect(focused).toBe(list().querySelector('[data-section="levels"]'));
    expect(focused.closest('[hidden]')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/g/group1');
  });

  it('does not navigate back to the group once the page has been left', async () => {
    await harness.navigateByUrl('/g/group1?settings=levels', GroupHome);
    const group = httpMock.expectOne(`${B}/groups/group1`);
    const sessions = httpMock.expectOne(`${B}/groups/group1/sessions`);
    await harness.navigateByUrl('/groups/new');
    for (const r of httpMock.match(() => true)) r.flush([]);
    group.flush({ code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null });
    sessions.flush([]);
    await settle();
    await tick();
    expect(TestBed.inject(Router).url).toBe('/groups/new');
    for (const r of httpMock.match(() => true)) r.flush([]);
  });

  it('an unknown ?settings value opens settings without moving focus', async () => {
    await open('/g/group1?settings=bogus');
    flushValues();
    await settle();
    await tick();
    expect(list().hidden).toBe(false);
    expect((document.activeElement as HTMLElement | null)?.dataset?.['section']).toBeUndefined();
  });

  it('a 404 shows not-found — no settings, no start, nothing to fill in', async () => {
    await harness.navigateByUrl('/g/group1', GroupHome);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await settle();
    expect(el().textContent).toContain('ไม่พบก๊วนนี้');
    expect(el().querySelector('[data-settings-trigger]')).toBeNull();
    expect(el().querySelector('[data-start]')).toBeNull();
  });

  it('a network failure is a retryable error, not not-found', async () => {
    const page = await harness.navigateByUrl('/g/group1', GroupHome);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 0, statusText: 'Network' });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('โหลดก๊วนไม่สำเร็จ');
    expect(el().textContent).not.toContain('ไม่พบก๊วนนี้');
    void page.load();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await settle();
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนอังคาร');
  });

  it('opens a legacy 8-hex group the same way', async () => {
    await harness.navigateByUrl('/g/abcd1234', GroupHome);
    httpMock.expectOne(`${B}/groups/abcd1234`).flush({ code: 'abcd1234', name: 'เก่า', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/abcd1234/sessions`).flush([]);
    await settle();
    expect(el().querySelector('h1')?.textContent).toContain('เก่า');
  });
});
