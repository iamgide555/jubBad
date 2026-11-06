import {
  ALT_TEXT_MAX,
  cardTexts,
  clip,
  COURT,
  HEADER_LABEL,
  HEADER_TITLE,
  INK,
  INK_SOFT,
  present,
  TEXT_MAX,
} from './line-summary-card.js';

/**
 * The awards card posted when the host closes the collection (ปิดการเก็บเงิน): a podium for the three fastest
 * payers and a spotlight on the slowest. Pure data in, Flex out; the service decides who is ranked and when it
 * is sent. See docs/overview.md, "The awards card".
 */

export interface AwardsPaid {
  playerId: string;
  name: string;
  /** The LINE profile picture address, or null when the player has no linked LINE account. */
  pictureUrl: string | null;
  paidAt: Date;
}

export interface AwardsWinner {
  name: string;
  pictureUrl: string | null;
  /** Pay time minus the session's end, never negative. */
  delayMs: number;
}

export interface AwardsView {
  /** One entry per podium place, in rank order (gold, silver, bronze); shorter than 3 when fewer people paid. */
  podium: AwardsWinner[];
  /** The slowest payer, only when the night had enough payers and the gap to the champion is real. */
  turtle: AwardsWinner | null;
  /** Everyone on the bill, for "จ่ายครบแล้ว X คน". */
  everyoneCount: number;
  /** A rank title per podium place. */
  titles: string[];
}

export interface AwardsCardInput {
  groupName: string | null;
  date: string | null;
  endedAt: Date;
  venue: string | null;
  view: AwardsView;
}

/** The turtle needs at least this many ranked payers, so it is never a podium winner too. */
export const TURTLE_MIN_RANKED = 4;
/** And it must be this much slower than the champion, so a bulk tick or a quick night never crowns a "slowest". */
export const TURTLE_MIN_GAP_MS = 30 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Pay time as the card prints it: ทันที, N นาที, N ชม. M นาที, N วัน M ชม. */
export function formatPayDelay(ms: number): string {
  const delay = Math.max(0, Math.floor(ms));
  if (delay < MINUTE) return 'ทันที';
  if (delay < HOUR) return `${Math.floor(delay / MINUTE)} นาที`;
  if (delay < DAY) {
    const hours = Math.floor(delay / HOUR);
    const minutes = Math.floor((delay % HOUR) / MINUTE);
    return minutes === 0 ? `${hours} ชม.` : `${hours} ชม. ${minutes} นาที`;
  }
  const days = Math.floor(delay / DAY);
  const hours = Math.floor((delay % DAY) / HOUR);
  return hours === 0 ? `${days} วัน` : `${days} วัน ${hours} ชม.`;
}

const TITLES: readonly (readonly string[])[] = [
  ['มือไวกว่าตบ', 'โอนก่อนเหงื่อแห้ง', 'ATM เดินได้', 'เร็วกว่าลูกตบ'],
  ['ไวรองแชมป์', 'ตามติดไม่ห่าง', 'เกือบได้ทอง'],
  ['ทันขึ้นโพเดียม', 'เส้นยาแดงผ่าแปด', 'โพเดียมสุดท้าย'],
];

/** A small stable hash, so the same session always draws the same titles and next week's differ. */
function hashOf(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h;
}

function compareThai(a: string, b: string): number {
  return a.localeCompare(b, 'th');
}

/**
 * Ranks the people who paid, earliest first. Ties in time fall to name and then player id, so two renders of the
 * same night always agree. Returns null when nobody is ranked (the card is not sent then).
 */
export function rankAwards(input: {
  paid: AwardsPaid[];
  endedAt: Date;
  sessionCode: string;
  everyoneCount: number;
}): AwardsView | null {
  if (input.paid.length === 0) return null;
  const ranked = [...input.paid].sort(
    (a, b) =>
      a.paidAt.getTime() - b.paidAt.getTime() ||
      compareThai(a.name, b.name) ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
  const toWinner = (p: AwardsPaid): AwardsWinner => ({
    name: p.name,
    pictureUrl: p.pictureUrl,
    delayMs: Math.max(0, p.paidAt.getTime() - input.endedAt.getTime()),
  });
  const podium = ranked.slice(0, 3).map(toWinner);
  const last = ranked.length >= TURTLE_MIN_RANKED ? toWinner(ranked[ranked.length - 1]) : null;
  const turtle = last !== null && last.delayMs - podium[0].delayMs >= TURTLE_MIN_GAP_MS ? last : null;
  const seed = hashOf(input.sessionCode);
  const titles = podium.map((_, i) => TITLES[i][(seed + i) % TITLES[i].length]);
  return { podium, turtle, everyoneCount: input.everyoneCount, titles };
}

/** Only an https address LINE can fetch and fits its 2000-character limit is used; anything else shows the fallback. */
export function usablePicture(url: string | null): string | null {
  if (url === null || url.length > 2000 || !url.startsWith('https://')) return null;
  return url;
}

// Metals and the spotlight. Gold is DESIGN.md's winner mark; the light gold reads on the dark spotlight.
const GOLD_ON_DARK = '#e3b155';
const COURT_SOFT = '#e8f3ec';
const SPOTLIGHT_BG = INK;
const PILL_BG = '#16130fcc';
export const TURTLE_LINE = '"ลูกโด่งยังตกพื้นเร็วกว่า"';

/**
 * Where each podium step's top edge sits, as a percentage of the podium image's height, and the left edge of each
 * place's column as a percentage of its width. The art (web/public/line/awards-podium.png) is drawn to these
 * numbers: change one and the other must move with it.
 */
export const STEP_TOP_PERCENT = [50, 64, 72] as const;
const COLUMN_START_PERCENT = [33.33, 0, 66.66] as const; // gold sits in the middle, silver left, bronze right
const COLUMN_WIDTH = '33.33%';

export const PODIUM_ART = 'awards-podium.png';
export const TURTLE_ART = 'golden-turtle.png';
const MEDALS = ['🥇', '🥈', '🥉'] as const;

const pct = (n: number): string => `${Math.round(n * 100) / 100}%`;
const nameOf = (name: string): string => clip(present(name) ?? '-', TEXT_MAX);

function artUrl(artBase: string, file: string): string {
  return `${artBase.replace(/\/+$/, '')}/line/${file}`;
}

/** A round avatar: the LINE picture on a tinted circle, or the fallback emoji when there is no usable picture. */
function avatar(pictureUrl: string | null, fallback: string, width: string) {
  const picture = usablePicture(pictureUrl);
  return {
    type: 'box',
    layout: 'vertical',
    width,
    cornerRadius: '100px',
    backgroundColor: COURT_SOFT,
    justifyContent: 'center',
    alignItems: 'center',
    contents: [
      picture !== null
        ? { type: 'image', url: picture, size: 'full', aspectMode: 'cover', aspectRatio: '1:1' }
        : { type: 'text', text: fallback, size: 'xl', align: 'center' },
    ],
  };
}

/** One winner standing on their step: avatar, name and rank title, growing upward from the step's top edge. */
function winnerOverlay(place: number, winner: AwardsWinner, title: string) {
  return {
    type: 'box',
    layout: 'vertical',
    position: 'absolute',
    width: COLUMN_WIDTH,
    offsetStart: pct(COLUMN_START_PERCENT[place]),
    offsetBottom: pct(100 - STEP_TOP_PERCENT[place]),
    alignItems: 'center',
    spacing: 'xs',
    paddingAll: 'xs',
    contents: [
      avatar(winner.pictureUrl, MEDALS[place], '40%'),
      { type: 'text', text: nameOf(winner.name), size: 'xs', weight: 'bold', color: INK, align: 'center', maxLines: 1 },
      { type: 'text', text: title, size: 'xxs', color: INK_SOFT, align: 'center', wrap: true, maxLines: 2 },
    ],
  };
}

/** A step nobody has reached: a deliberate muted gag rather than what reads as a rendering hole. */
function vacantOverlay(place: number) {
  return {
    type: 'box',
    layout: 'vertical',
    position: 'absolute',
    width: COLUMN_WIDTH,
    offsetStart: pct(COLUMN_START_PERCENT[place]),
    offsetBottom: pct(100 - STEP_TOP_PERCENT[place]),
    alignItems: 'center',
    paddingAll: 'xs',
    contents: [{ type: 'text', text: 'ว่าง 🏸', size: 'xs', color: INK_SOFT, align: 'center' }],
  };
}

/** The pay time on the lower, plain part of the step face, in a dark pill so it reads on any metal. */
function timeOverlay(place: number, delayMs: number) {
  const top = STEP_TOP_PERCENT[place];
  return {
    type: 'box',
    layout: 'vertical',
    position: 'absolute',
    width: COLUMN_WIDTH,
    offsetStart: pct(COLUMN_START_PERCENT[place]),
    offsetTop: pct(top + 0.58 * (100 - top)),
    alignItems: 'center',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: PILL_BG,
        cornerRadius: 'xxl',
        paddingStart: 'md',
        paddingEnd: 'md',
        paddingTop: 'xs',
        paddingBottom: 'xs',
        contents: [{ type: 'text', text: formatPayDelay(delayMs), size: 'xs', weight: 'bold', color: '#ffffff' }],
      },
    ],
  };
}

function podium(view: AwardsView, artBase: string | null) {
  const overlays: unknown[] = [];
  for (let place = 0; place < 3; place++) {
    const winner = view.podium[place];
    if (winner === undefined) {
      overlays.push(vacantOverlay(place));
    } else {
      overlays.push(winnerOverlay(place, winner, view.titles[place]), timeOverlay(place, winner.delayMs));
    }
  }
  const art =
    artBase === null
      ? { type: 'box', layout: 'vertical', height: '260px', backgroundColor: COURT_SOFT, contents: [{ type: 'filler' }] }
      : { type: 'image', url: artUrl(artBase, PODIUM_ART), size: 'full', aspectRatio: '4:3', aspectMode: 'cover' };
  return { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [art, ...overlays] };
}

function spotlight(turtle: AwardsWinner, artBase: string | null) {
  const picture =
    artBase === null
      ? { type: 'text', text: '🐢', size: '4xl', align: 'center', gravity: 'center', flex: 4 }
      : { type: 'image', url: artUrl(artBase, TURTLE_ART), size: 'full', aspectRatio: '1:1', aspectMode: 'fit', flex: 4 };
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: SPOTLIGHT_BG,
    cornerRadius: 'lg',
    paddingAll: 'lg',
    margin: 'md',
    spacing: 'md',
    contents: [
      picture,
      {
        type: 'box',
        layout: 'vertical',
        flex: 6,
        spacing: 'xs',
        justifyContent: 'center',
        contents: [
          { type: 'text', text: 'รางวัลเต่าทองคำ', size: 'xs', weight: 'bold', color: GOLD_ON_DARK },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            alignItems: 'center',
            contents: [
              avatar(turtle.pictureUrl, '🐢', '28px'),
              { type: 'text', text: nameOf(turtle.name), size: 'md', weight: 'bold', color: '#ffffff', wrap: true, maxLines: 1, flex: 1 },
            ],
          },
          { type: 'text', text: formatPayDelay(turtle.delayMs), size: 'xl', weight: 'bold', color: GOLD_ON_DARK },
          { type: 'text', text: TURTLE_LINE, size: 'xs', color: '#ffffff', wrap: true },
        ],
      },
    ],
  };
}

function altText(input: AwardsCardInput): string {
  const { name } = cardTexts(input);
  const champion = input.view.podium[0];
  const parts = [`🏆 ประกาศรางวัลจ่ายไว ${name}`];
  if (champion) parts.push(`🥇 ${nameOf(champion.name)}`);
  // The roasted person is deliberately not named here: the alt text shows on lock screens.
  if (input.view.turtle) parts.push('🐢 ใครเอ่ยมาช้าสุด?');
  return clip(parts.join(' · '), ALT_TEXT_MAX);
}

function awardsCard(input: AwardsCardInput, artBase: string | null, footer: unknown[]) {
  const { name, date } = cardTexts(input);
  // The podium runs edge to edge; the spotlight and the count sit in a padded block beneath it.
  const below: unknown[] = [];
  if (input.view.turtle) below.push(spotlight(input.view.turtle, artBase));
  below.push({
    type: 'text',
    text: `จ่ายครบแล้ว ${input.view.everyoneCount} คน 🎉`,
    size: 'sm',
    weight: 'bold',
    color: COURT,
    align: 'center',
    margin: 'md',
  });
  const body: unknown[] = [podium(input.view, artBase), { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: below }];
  return {
    type: 'flex',
    altText: altText(input),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COURT,
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🏆 ประกาศรางวัลจ่ายไว', size: 'xs', color: HEADER_LABEL },
          { type: 'text', text: name, size: 'lg', weight: 'bold', color: HEADER_TITLE, wrap: true },
          { type: 'text', text: date, size: 'xs', color: HEADER_LABEL },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: body },
      ...(footer.length > 0
        ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
        : {}),
    },
  };
}

/** The card for the bot's post into the LINE group: an optional "ดูสถานะการจ่าย" button and nothing else. */
export function awardsGroupMessages(input: AwardsCardInput, artBase: string | null, statusUrl: string | null): unknown[] {
  const footer: unknown[] = [];
  if (statusUrl) {
    footer.push({ type: 'button', style: 'secondary', action: { type: 'uri', label: 'ดูสถานะการจ่าย', uri: statusUrl } });
  }
  return [awardsCard(input, artBase, footer)];
}

/** The card the bot DMs the host: the same card under a muted "not in the group yet" line and ส่งเข้ากลุ่ม. */
export function awardsDmMessages(input: AwardsCardInput, artBase: string | null, shareUrl: string): unknown[] {
  return [
    awardsCard(input, artBase, [
      { type: 'text', text: 'การ์ดนี้ยังไม่อยู่ในกลุ่ม', size: 'xs', color: INK_SOFT, wrap: true },
      { type: 'button', style: 'primary', color: COURT, action: { type: 'uri', label: 'ส่งเข้ากลุ่ม', uri: shareUrl } },
    ]),
  ];
}
