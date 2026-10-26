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
import { stubPlanService } from '../../core/plan.testing';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';

const B = environment.apiBaseUrl;
const tick = () => new Promise<void>((r) => setTimeout(r));
const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
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
  let plan: ReturnType<typeof stubPlanService>;

  beforeEach(async () => {
    plan = stubPlanService();
    TestBed.configureTestingModule({
      providers: [
        plan.provider,
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

  function flushValues(over: { players?: number; custom?: boolean; shared?: boolean; shuttle?: boolean; history?: boolean; lineLinked?: boolean } = {}) {
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
    httpMock.expectOne(`${B}/groups/group1/line`).flush({
      configured: true,
      botAddUrl: 'https://lin.ee/jubbad',
      linked: over.lineLinked ?? false,
      lineGroupName: over.lineLinked ? 'ก๊วนไลน์' : null,
      linkedAt: over.lineLinked ? '2026-10-20T10:00:00.000Z' : null,
      leftAt: null,
    });
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

  describe('archive window note', () => {
    const note = () => el().querySelector('[data-archive-note]');

    it('free: says only the last 30 days are shown', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      plan.answer('free', null, { archiveHidden: 3 });
      await settle();
      expect(plan.calls).toEqual(['group1']);
      expect(note()?.textContent).toContain('แสดงเฉพาะรอบใน 30 วันล่าสุด');
    });

    it('free: still says so when no session falls inside the window but some are hidden', async () => {
      await open();
      plan.answer('free', null, { archiveHidden: 5 });
      await settle();
      expect(note()?.textContent).toContain('แสดงเฉพาะรอบใน 30 วันล่าสุด');
    });

    it('free: no note, and no empty past-rounds heading, when nothing is hidden', async () => {
      await open();
      plan.answer('free', null, { archiveHidden: 0 });
      await settle();
      expect(note()).toBeNull();
      expect(el().textContent).not.toContain('รอบที่ผ่านมา');
    });

    it('free: the note points to the Host plan for the full history', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      plan.answer('free', null, { archiveHidden: 3 });
      await settle();
      expect(note()?.textContent?.trim()).toBe('แสดงเฉพาะรอบใน 30 วันล่าสุด ดูย้อนหลังทั้งหมดได้ในแพ็ก⁠เกจโฮสต์');
    });

    it('host: no note', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      plan.answer('host');
      await settle();
      expect(note()).toBeNull();
    });

    it('an unknown plan (never answered) shows no note', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      expect(note()).toBeNull();
    });

    it('a failed plan read shows no note', async () => {
      await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
      plan.fail();
      await settle();
      expect(note()).toBeNull();
    });
  });

  describe('plan line in the settings disclosure', () => {
    const line = () => list().querySelector('[data-plan-line]');

    it('free: names the plan and never shows a date, even with one stored', async () => {
      await open();
      plan.answer('free', '2026-11-19T16:59:59.999Z');
      await settle();
      expect(line()?.textContent?.trim()).toBe('แพ็ก⁠เกจ: ฟรี');
    });

    it('host with a renewal date: names the plan and the Bangkok date it runs until', async () => {
      await open();
      plan.answer('host', '2026-11-19T16:59:59.999Z');
      await settle();
      expect(line()?.textContent?.trim()).toBe('แพ็ก⁠เกจ: โฮสต์ · ถึง 19/11/2026');
    });

    it('club with no renewal date: just the plan', async () => {
      await open();
      plan.answer('club');
      await settle();
      expect(line()?.textContent?.trim()).toBe('แพ็ก⁠เกจ: ก๊วนใหญ่');
    });

    it('an unknown plan (never answered) shows nothing', async () => {
      await open();
      expect(line()).toBeNull();
    });

    it('a failed plan read shows nothing', async () => {
      await open();
      plan.fail();
      await settle();
      expect(line()).toBeNull();
    });
  });

  describe('rows that lead nowhere on a free plan are disabled', () => {
    const row = (s: string) => list().querySelector<HTMLElement>(`[data-section="${s}"]`)!;
    const byId = (id: string) => document.getElementById(id);

    async function openSettings(answer: 'free' | 'host' | 'club' | 'fail' | null, values: Parameters<typeof flushValues>[0] = {}) {
      await open();
      if (answer === 'fail') plan.fail();
      else if (answer) plan.answer(answer);
      trigger().click();
      await harness.fixture.whenStable();
      flushValues(values);
      await settle();
    }

    const expectDisabled = (s: string) => {
      const r = row(s);
      // Locked, but a real button: it opens the upgrade sheet, so it is not announced as disabled.
      expect(r.tagName).toBe('BUTTON');
      expect(r.hasAttribute('aria-disabled')).toBe(false);
      expect(r.hasAttribute('href')).toBe(false);
      expect(r.classList.contains('locked')).toBe(true);
      expect(r.querySelector('.row-chevron')).toBeNull();
      // The status badge is replaced by the plan badge.
      const badges = [...r.querySelectorAll('.value')].map((b) => b.textContent?.trim());
      expect(badges).toEqual(['แพ็ก⁠เกจโฮสต์']);
      // A screen reader hears why: the description and the plan hint, by id.
      const described = r.getAttribute('aria-describedby')!.split(/\s+/).map((id) => byId(id)?.textContent?.trim());
      expect(described).toContain('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
      expect(byId(r.getAttribute('aria-labelledby')!)?.textContent?.trim()).toBeTruthy();
    };

    const expectLink = (s: string) => {
      const r = row(s);
      expect(r.tagName).toBe('A');
      expect(r.hasAttribute('aria-disabled')).toBe(false);
      expect(r.getAttribute('href')).toBeTruthy();
      expect(r.querySelector('.row-chevron')).not.toBeNull();
      expect(r.textContent).not.toContain('แพ็ก⁠เกจโฮสต์');
    };

    it('free with nothing set up: levels, share and advanced are disabled; players and manage stay links', async () => {
      await openSettings('free');
      for (const s of ['levels', 'share', 'advanced']) expectDisabled(s);
      for (const s of ['players', 'manage']) expectLink(s);
    });

    it('a locked row opens the upgrade sheet and does not navigate when tapped', async () => {
      await openSettings('free');
      const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      const sheet = vi.spyOn(TestBed.inject(UpgradeSheetService), 'open').mockImplementation(() => undefined);
      for (const s of ['levels', 'share', 'advanced']) row(s).click();
      expect(nav).not.toHaveBeenCalled();
      expect(sheet).toHaveBeenCalledTimes(3);
    });

    it('free with a share token: share stays a link so the host can stop sharing', async () => {
      await openSettings('free', { shared: true });
      expectLink('share');
      expect(row('share').querySelector('.value')?.textContent?.trim()).toBe('แชร์อยู่');
    });

    it('free with one advanced switch on: advanced stays a link so the host can turn it off', async () => {
      await openSettings('free', { history: true });
      expectLink('advanced');
      // Stored on, but new rounds snapshot it off on free: said so, and not drawn as active.
      const badge = row('advanced').querySelector('.value')!;
      expect(badge.textContent?.trim()).toBe('ปิดในแพ็ก⁠เกจฟรี');
      expect(badge.classList.contains('on')).toBe(false);
    });

    it('host with one advanced switch on: still reads เปิด 1 จาก 2, drawn as on', async () => {
      await openSettings('host', { history: true });
      const badge = row('advanced').querySelector('.value')!;
      expect(badge.textContent?.trim()).toBe('เปิด 1 จาก 2');
      expect(badge.classList.contains('on')).toBe(true);
    });

    it('free with the shuttle switch on: advanced stays a link', async () => {
      await openSettings('free', { shuttle: true });
      expectLink('advanced');
    });

    it('free with a custom ladder: levels stays a link so the host can still see it', async () => {
      await openSettings('free', { custom: true });
      expectLink('levels');
    });

    it('free but a fact is still unknown (fetch failed): that row stays a link', async () => {
      await open();
      plan.answer('free');
      trigger().click();
      await harness.fixture.whenStable();
      httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
      httpMock.expectOne(`${B}/groups/group1/levels`).flush('x', { status: 500, statusText: 'x' });
      httpMock.expectOne(`${B}/groups/group1/share`).flush('x', { status: 500, statusText: 'x' });
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: false });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush('x', { status: 500, statusText: 'x' });
      httpMock.expectOne(`${B}/groups/group1/line`).flush('x', { status: 500, statusText: 'x' });
      await settle();
      await tick();
      for (const s of ['players', 'levels', 'share', 'line', 'advanced', 'manage']) expectLink(s);
    });

    for (const answer of ['host', 'club', 'fail', null] as const) {
      it(`${answer ?? 'unknown'} plan: every row is an ordinary link, even with nothing set up`, async () => {
        await openSettings(answer);
        for (const s of ['players', 'levels', 'share', 'line', 'advanced', 'manage']) expectLink(s);
      });
    }

    it('free and not linked: the LINE group row is locked like the other paid rows', async () => {
      await openSettings('free');
      expectDisabled('line');
    });

    it('free but still linked: the row stays a link marked paused, so the host can reach Unlink', async () => {
      await openSettings('free', { lineLinked: true });
      expectLink('line');
      expect(row('line').querySelector('.value')?.textContent?.trim()).toBe('หยุดชั่วคราว');
      expect(row('line').querySelector('.value')?.classList.contains('on')).toBe(false);
    });

    it('host and not linked: the row reads ยังไม่เชื่อม and is not drawn as on', async () => {
      await openSettings('host');
      expect(row('line').querySelector('.value')?.textContent?.trim()).toBe('ยังไม่เชื่อม');
      expect(row('line').querySelector('.value')?.classList.contains('on')).toBe(false);
    });
  });

  describe('a linked LINE group on a paid plan', () => {
    it('the LINE group row reads เชื่อมแล้ว and is drawn as on', async () => {
      await open();
      plan.answer('host');
      trigger().click();
      await harness.fixture.whenStable();
      flushValues({ lineLinked: true });
      await settle();
      const badge = list().querySelector<HTMLElement>('[data-section="line"] .value')!;
      expect(badge.textContent?.trim()).toBe('เชื่อมแล้ว');
      expect(badge.classList.contains('on')).toBe(true);
    });
  });

  describe('plan notice and a paused group', () => {
    const notice = () => el().querySelector('[data-plan-notice]');
    const start = () => el().querySelector('[data-start]');

    it('shows nothing and keeps the start link while the plan is unknown', async () => {
      await open();
      expect(notice()).toBeNull();
      expect(start()).not.toBeNull();
    });

    it('a lapsed plan shows the notice under the title, and the start link stays', async () => {
      await open();
      plan.answer('free', daysAgoIso(5), { lapsedAt: daysAgoIso(5) });
      await settle();
      expect(notice()?.getAttribute('data-plan-notice')).toBe('lapsed');
      expect(start()).not.toBeNull();
    });

    it('a paused group shows the notice and no start link or start hint', async () => {
      await open();
      plan.answer('free', null, { paused: true });
      await settle();
      expect(notice()?.getAttribute('data-plan-notice')).toBe('paused');
      expect(start()).toBeNull();
      expect(el().querySelector('.start-sub')).toBeNull();
    });
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

    // One link holding a label, a title, a date, a venue and a count would read as a single long
    // run. The title names it; the label line and the sub-line are the description.
    describe('the card is named by its title and described by its label and sub-line', () => {
      const byId = (id: string) => el().querySelector<HTMLElement>(`[id="${id}"]`);
      const expectNamedByTitle = (title: string) => {
        const card = resume();
        const labelledBy = card.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        expect(labelledBy!.trim().split(/\s+/)).toHaveLength(1);
        const named = byId(labelledBy!)!;
        expect(named).toBe(card.querySelector('.resume-title'));
        expect(named.textContent?.trim()).toBe(title);

        const describedBy = card.getAttribute('aria-describedby')!.trim().split(/\s+/);
        expect(describedBy).toHaveLength(2);
        expect(byId(describedBy[0])).toBe(card.querySelector('.resume-label'));
        expect(byId(describedBy[1])).toBe(card.querySelector('.resume-sub'));
        // Neither is the name, and every id is unique on the page.
        expect(describedBy).not.toContain(labelledBy);
        for (const id of [labelledBy!, ...describedBy]) expect(el().querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        const ids = [...el().querySelectorAll('[id]')].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      };

      it('a live card is named กลับไปรอบที่เล่นอยู่ and described by กำลังเล่นอยู่ and the sub-line', async () => {
        await open('/g/group1', { lastSessionCode: 's1', sessions: [{ ...LIVE, venue: 'KIP' }] });
        expectNamedByTitle('กลับไปรอบที่เล่นอยู่');
        expect(byId(resume().getAttribute('aria-describedby')!.split(' ')[0])!.textContent).toContain('กำลังเล่นอยู่');
        expect(byId(resume().getAttribute('aria-describedby')!.split(' ')[1])!.textContent).toContain('KIP');
      });

      it('an open card is named ดูรอบล่าสุด and described by ยังไม่ปิดรอบ and the sub-line', async () => {
        await open('/g/group1', { lastSessionCode: 's1', sessions: [OPEN] });
        expectNamedByTitle('ดูรอบล่าสุด');
        expect(byId(resume().getAttribute('aria-describedby')!.split(' ')[0])!.textContent).toContain('ยังไม่ปิดรอบ');
      });

      it('the ended text link keeps its own text as its name', async () => {
        await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
        expect(resume().hasAttribute('aria-labelledby')).toBe(false);
        expect(resume().hasAttribute('aria-describedby')).toBe(false);
        expect(resume().textContent).toContain('ดูรอบล่าสุด');
      });
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

  it('opening settings reveals six rows in order, with management last', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(list().hidden).toBe(false);
    const rows = [...list().querySelectorAll<HTMLAnchorElement>('a[data-section]')];
    expect(rows.map((r) => r.dataset['section'])).toEqual(['players', 'levels', 'share', 'line', 'advanced', 'manage']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/g/group1/players',
      '/g/group1/levels',
      '/g/group1/settings/share',
      '/g/group1/settings/line',
      '/g/group1/settings/advanced',
      '/g/group1/settings/manage',
    ]);
    expect(rows[5].textContent).toContain('ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน');
    const titles = ['จัดการผู้เล่น', 'ระดับผู้เล่นของก๊วน', 'แชร์หน้าสรุปก๊วน', 'กลุ่ม LINE', 'ตั้งค่าขั้นสูง', 'จัดการก๊วน'];
    rows.forEach((r, i) => {
      const id = r.getAttribute('aria-labelledby')!;
      expect(document.getElementById(id)?.textContent?.trim()).toBe(titles[i]);
    });
  });

  it('the settings wrapper holds two lists: five routine rows, then management alone', async () => {
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
      'line',
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
    httpMock.expectOne(`${B}/groups/group1/line`).flush('x', { status: 500, statusText: 'x' });
    await settle();
    await tick();
    expect(list().querySelectorAll('.value').length).toBe(0);
    expect(list().querySelector('[data-section="players"]')?.textContent).toContain('รายชื่อ ระดับ ข้อมูลติดต่อ และกฎการจับคู่');
  });

  it('the players row describes everything that page holds: names, levels, contact details and pairing rules', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    expect(el().querySelector('#desc-players')?.textContent?.trim()).toBe('รายชื่อ ระดับ ข้อมูลติดต่อ และกฎการจับคู่');
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

  it('Escape while the upgrade sheet is open leaves the settings list alone', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await settle();
    const sheet = TestBed.inject(UpgradeSheetService);
    sheet.isOpen.set(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(list().hidden).toBe(false);
    sheet.isOpen.set(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(list().hidden).toBe(true);
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
