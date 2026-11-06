import { describe, expect, it } from 'vitest';
import {
  awardsDmMessages,
  awardsGroupMessages,
  formatPayDelay,
  rankAwards,
  STEP_TOP_PERCENT,
  TURTLE_LINE,
  TURTLE_MIN_GAP_MS,
  usablePicture,
  type AwardsCardInput,
  type AwardsPaid,
} from './payment-awards-card.js';

const ENDED = new Date('2026-10-25T14:00:00Z');
const MIN = 60_000;

const at = (minutes: number): Date => new Date(ENDED.getTime() + minutes * MIN);
const paid = (id: string, name: string, minutes: number, pictureUrl: string | null = null): AwardsPaid => ({
  playerId: id,
  name,
  pictureUrl,
  paidAt: at(minutes),
});

function rank(entries: AwardsPaid[], sessionCode = 'S1') {
  return rankAwards({ paid: entries, endedAt: ENDED, sessionCode, everyoneCount: entries.length + 1 });
}

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node as Node);
  Object.values(node as Node).forEach((v) => walk(v, visit));
}

function texts(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n['type'] === 'text') out.push(String(n['text']));
  });
  return out;
}

function inputFor(entries: AwardsPaid[]): AwardsCardInput {
  const view = rank(entries);
  if (view === null) throw new Error('expected a view');
  return { groupName: 'ตีชิล', date: '2026-10-25', endedAt: ENDED, venue: null, view };
}

const NINE = [
  paid('a', 'Oggy', 3),
  paid('b', 'Trim', 9),
  paid('c', 'pom', 14),
  paid('d', 'Maiwa', 40),
  paid('e', 'Kin', 90),
  paid('f', 'tune', 2 * 24 * 60 + 4 * 60),
];

describe('formatPayDelay', () => {
  it('reads the boundaries', () => {
    expect(formatPayDelay(0)).toBe('ทันที');
    expect(formatPayDelay(59_999)).toBe('ทันที');
    expect(formatPayDelay(MIN)).toBe('1 นาที');
    expect(formatPayDelay(59 * MIN)).toBe('59 นาที');
    expect(formatPayDelay(60 * MIN)).toBe('1 ชม.');
    expect(formatPayDelay(95 * MIN)).toBe('1 ชม. 35 นาที');
    expect(formatPayDelay(24 * 60 * MIN)).toBe('1 วัน');
    expect(formatPayDelay((2 * 24 * 60 + 4 * 60) * MIN)).toBe('2 วัน 4 ชม.');
  });

  it('clamps a negative delay to ทันที', () => {
    expect(formatPayDelay(-5 * MIN)).toBe('ทันที');
  });
});

describe('rankAwards', () => {
  it('ranks by pay time and builds the podium from the first three', () => {
    const view = rank([NINE[2], NINE[0], NINE[1], NINE[3]])!;
    expect(view.podium.map((w) => w.name)).toEqual(['Oggy', 'Trim', 'pom']);
    expect(view.podium.map((w) => w.delayMs)).toEqual([3 * MIN, 9 * MIN, 14 * MIN]);
  });

  it('returns null when nobody is ranked', () => {
    expect(rank([])).toBeNull();
  });

  it('breaks time ties by name and then player id, so the order never flickers', () => {
    const view = rank([paid('2', 'ข', 5), paid('1', 'ก', 5), paid('4', 'ข', 5), paid('3', 'ก', 5)])!;
    expect(view.podium.map((w) => w.name)).toEqual(['ก', 'ก', 'ข']);
    const again = rank([paid('4', 'ข', 5), paid('3', 'ก', 5), paid('1', 'ก', 5), paid('2', 'ข', 5)])!;
    expect(again.podium).toEqual(view.podium);
  });

  it('clamps a payment recorded before the session ended to zero', () => {
    const view = rank([paid('a', 'Oggy', -30)])!;
    expect(view.podium[0].delayMs).toBe(0);
  });

  it('gives the turtle to the last payer with enough ranked people and a real gap', () => {
    const view = rank(NINE)!;
    expect(view.turtle?.name).toBe('tune');
    expect(view.turtle?.delayMs).toBe((2 * 24 * 60 + 4 * 60) * MIN);
  });

  it('has no turtle with fewer than 4 ranked', () => {
    expect(rank(NINE.slice(0, 3))!.turtle).toBeNull();
  });

  it('has no turtle when the slowest is under 30 minutes behind the champion', () => {
    const quick = [paid('a', 'A', 1), paid('b', 'B', 5), paid('c', 'C', 10), paid('d', 'D', 1 + TURTLE_MIN_GAP_MS / MIN - 1)];
    expect(rank(quick)!.turtle).toBeNull();
    const enough = [paid('a', 'A', 1), paid('b', 'B', 5), paid('c', 'C', 10), paid('d', 'D', 1 + TURTLE_MIN_GAP_MS / MIN)];
    expect(rank(enough)!.turtle?.name).toBe('D');
  });

  it('draws the same titles for the same session and keeps them in each pool', () => {
    const one = rank(NINE, 'ABC')!;
    expect(rank(NINE, 'ABC')!.titles).toEqual(one.titles);
    expect(one.titles).toHaveLength(3);
    one.titles.forEach((t) => expect(t.length).toBeGreaterThan(0));
  });
});

describe('usablePicture', () => {
  it('accepts a short https address only', () => {
    expect(usablePicture('https://profile.line-scdn.net/abc')).toBe('https://profile.line-scdn.net/abc');
    expect(usablePicture(null)).toBeNull();
    expect(usablePicture('http://profile.line-scdn.net/abc')).toBeNull();
    expect(usablePicture(`https://x/${'a'.repeat(2000)}`)).toBeNull();
  });
});

describe('the awards card', () => {
  const ART = 'https://jubbad.example';

  function bubble(input: AwardsCardInput, art: string | null = ART): Node {
    const [card] = awardsGroupMessages(input, art, null) as Node[];
    return (card as { contents: Node }).contents;
  }

  it('shows the podium names, titles and times, and the turtle spotlight', () => {
    const input = inputFor(NINE);
    const all = texts(bubble(input));
    for (const name of ['Oggy', 'Trim', 'pom', 'tune']) expect(all).toContain(name);
    expect(all).toContain('3 นาที');
    expect(all).toContain('รางวัลเต่าทองคำ');
    expect(all).toContain('2 วัน 4 ชม.');
    expect(all).toContain(TURTLE_LINE);
    expect(all).toContain(`จ่ายครบแล้ว ${input.view.everyoneCount} คน 🎉`);
    input.view.titles.forEach((t) => expect(all).toContain(t));
  });

  it('does not list the players who did not place', () => {
    const all = texts(bubble(inputFor(NINE)));
    expect(all).not.toContain('Maiwa');
    expect(all).not.toContain('Kin');
  });

  it('is podium-only with no spotlight when there is no turtle', () => {
    const all = texts(bubble(inputFor(NINE.slice(0, 3))));
    expect(all).not.toContain('รางวัลเต่าทองคำ');
  });

  it('marks a vacant step with 1 or 2 ranked', () => {
    const one = texts(bubble(inputFor([NINE[0]])));
    expect(one.filter((t) => t === 'ว่าง 🏸')).toHaveLength(2);
    const two = texts(bubble(inputFor([NINE[0], NINE[1]])));
    expect(two.filter((t) => t === 'ว่าง 🏸')).toHaveLength(1);
  });

  it('never contains an empty text component', () => {
    for (const entries of [NINE, NINE.slice(0, 1), NINE.slice(0, 3)]) {
      for (const art of [ART, null]) {
        walk(bubble(inputFor(entries), art), (n) => {
          if (n['type'] === 'text') expect(String(n['text']).trim()).not.toBe('');
        });
      }
    }
  });

  it('anchors every winner overlay up from the top of its step', () => {
    const podium = (bubble(inputFor(NINE)) as { body: { contents: Node[] } }).body.contents[0] as {
      contents: Node[];
    };
    const bottoms = podium.contents
      .filter((n) => n['position'] === 'absolute' && n['offsetBottom'] !== undefined)
      .map((n) => n['offsetBottom']);
    expect(bottoms).toEqual([
      `${100 - STEP_TOP_PERCENT[0]}%`,
      `${100 - STEP_TOP_PERCENT[1]}%`,
      `${100 - STEP_TOP_PERCENT[2]}%`,
    ]);
  });

  it('uses the profile picture when usable and the medal emoji otherwise', () => {
    const withPicture = inputFor([paid('a', 'Oggy', 3, 'https://profile.line-scdn.net/abc'), NINE[1]]);
    const urls: string[] = [];
    walk(bubble(withPicture), (n) => {
      if (n['type'] === 'image') urls.push(String(n['url']));
    });
    expect(urls).toContain('https://profile.line-scdn.net/abc');
    const all = texts(bubble(withPicture));
    expect(all).toContain('🥈'); // Trim has no picture
    expect(all).not.toContain('🥇');
  });

  it('draws without the art when there is no public address, and with it otherwise', () => {
    const urls = (art: string | null): string[] => {
      const out: string[] = [];
      walk(bubble(inputFor(NINE), art), (n) => {
        if (n['type'] === 'image') out.push(String(n['url']));
      });
      return out;
    };
    expect(urls(ART)).toEqual([`${ART}/line/awards-podium.png`, `${ART}/line/golden-turtle.png`]);
    expect(urls(null)).toEqual([]);
    expect(texts(bubble(inputFor(NINE), null))).toContain('🐢');
  });

  it('keeps the roasted name out of the alt text', () => {
    const [card] = awardsGroupMessages(inputFor(NINE), ART, null) as { altText: string }[];
    expect(card.altText).toContain('Oggy');
    expect(card.altText).toContain('🐢');
    expect(card.altText).not.toContain('tune');
  });

  it('adds the status button on the group card only when there is a link', () => {
    const input = inputFor(NINE);
    const footer = (url: string | null) =>
      ((awardsGroupMessages(input, ART, url)[0] as Node)['contents'] as { footer?: { contents: Node[] } }).footer;
    expect(footer(null)).toBeUndefined();
    expect(footer('https://liff.line.me/x/payment-status/S1/T')?.contents).toHaveLength(1);
  });

  it('puts the share button and the not-in-group note on the DM card', () => {
    const [card] = awardsDmMessages(inputFor(NINE), ART, 'https://liff.line.me/x/pay/S1/T') as Node[];
    const all = texts(card);
    expect(all).toContain('การ์ดนี้ยังไม่อยู่ในกลุ่ม');
    const labels: string[] = [];
    walk(card, (n) => {
      const action = n['action'] as Node | undefined;
      if (action) labels.push(String(action['label']));
    });
    expect(labels).toEqual(['ส่งเข้ากลุ่ม']);
  });
});
