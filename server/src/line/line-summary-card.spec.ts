import { cardDate, summaryCard, type SummaryCardInput } from './line-summary-card.js';

const base: SummaryCardInput = {
  groupName: 'ก๊วนพฤหัส',
  date: '26 ต.ค.',
  endedAt: new Date('2026-10-26T15:30:00Z'),
  venue: 'Bad@Mama',
  players: 18,
  games: 42,
  url: 'https://jubbad.wongnok.dev/s/ABC/summary',
};

/** Every string leaf of a Flex tree, plus the nodes, so a test can assert on what a member would read. */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}
function texts(card: ReturnType<typeof summaryCard>): string[] {
  const out: string[] = [];
  walk(card.contents, (n) => {
    if (n.type === 'text') out.push(n.text as string);
  });
  return out;
}

describe('summaryCard', () => {
  it('shows the night totals and one button to the summary page', () => {
    const card = summaryCard(base);
    expect(card.type).toBe('flex');
    expect(card.altText).toBe('สรุปก๊วน ก๊วนพฤหัส 26 ต.ค.');
    expect(texts(card)).toEqual(
      expect.arrayContaining(['สรุปก๊วน', 'ก๊วนพฤหัส', '26 ต.ค.', 'Bad@Mama', '18 คน', '42 เกม'])
    );
    const buttons: Record<string, unknown>[] = [];
    walk(card.contents, (n) => {
      if (n.type === 'button') buttons.push(n);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action).toEqual({ type: 'uri', label: 'ดูสรุป', uri: base.url });
  });

  it('leaves the venue row out when the session has no venue', () => {
    for (const venue of [null, '  ']) {
      const all = texts(summaryCard({ ...base, venue }));
      expect(all).not.toContain('สนาม');
      expect(all).toContain('วันที่');
    }
  });

  it('falls back to a plain group label when the group has no name', () => {
    for (const groupName of [null, '', '   ']) {
      const all = texts(summaryCard({ ...base, groupName }));
      expect(all).toContain('ก๊วน');
    }
  });

  it('never emits an empty text, which LINE rejects', () => {
    for (const groupName of [null, '']) {
      for (const date of [null, '', ' ']) {
        for (const venue of [null, '']) {
          const card = summaryCard({ ...base, groupName, date, venue });
          expect(texts(card).every((t) => t.trim().length > 0)).toBe(true);
          expect(card.altText.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps altText within 400 characters', () => {
    const card = summaryCard({ ...base, groupName: 'ก'.repeat(500) });
    expect(card.altText.length).toBeLessThanOrEqual(400);
  });
});

describe('cardDate', () => {
  it('uses the session date text as written, trimmed', () => {
    expect(cardDate('  26 ต.ค.  ', base.endedAt)).toBe('26 ต.ค.');
  });

  it('falls back to the end date in Bangkok time when there is none', () => {
    // 18:30Z is 01:30 on the 27th in Bangkok, a different day than in UTC.
    const lateUtc = new Date('2026-10-26T18:30:00Z');
    for (const date of [null, '', '  ']) {
      const text = cardDate(date, lateUtc);
      expect(text).toContain('27');
      expect(text).toContain('ต.ค.');
    }
  });
});
