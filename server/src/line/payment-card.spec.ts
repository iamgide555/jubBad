import { describe, expect, it } from 'vitest';
import {
  formatBaht,
  liffPayUrl,
  PAYMENT_NUMBER_TEXT,
  paymentCardMessages,
  type PaymentCardInput,
} from './payment-card.js';

const INPUT: PaymentCardInput = {
  groupName: 'ตีชิล',
  date: '2026-10-29',
  endedAt: new Date('2026-10-29T14:00:00Z'),
  venue: 'Bad@Mama',
  rows: [
    { name: 'สมชาย', amountSatang: 144000, absent: false },
    { name: 'มาลี', amountSatang: 8550, absent: false },
  ],
  settledCount: 0,
  totalSatang: 152550,
  account: { bank: 'กสิกรไทย', number: '123-4-56789-0', name: 'สมหญิง ใจดี' },
};

type Node = Record<string, unknown>;

function bubble(
  input: PaymentCardInput = INPUT,
  target: 'group' | 'host' = 'group',
): Node {
  const [card] = paymentCardMessages(input, target) as Node[];
  return (card as { contents: Node }).contents;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node as Node);
  Object.values(node).forEach((n) => walk(n, visit));
}

function texts(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n['type'] === 'text') out.push(n['text'] as string);
  });
  return out;
}

/** The per-person rows: name/amount boxes with a right-aligned amount, minus the total row. */
function personRows(input: PaymentCardInput = INPUT) {
  const rows: { name: string; amount: Node }[] = [];
  walk((bubble(input) as { body: Node })['body'], (n) => {
    const parts = n['contents'];
    if (n['type'] !== 'box' || !Array.isArray(parts) || parts.length !== 2)
      return;
    const [label, amount] = parts as Node[];
    if (amount?.['align'] === 'end' && label?.['text'] !== 'รวม') {
      rows.push({ name: label?.['text'] as string, amount: amount });
    }
  });
  return rows;
}

describe('paymentCardMessages', () => {
  it('is a single bubble in a flex message, never a carousel', () => {
    const [card] = paymentCardMessages(INPUT, 'group') as Node[];
    expect(card['type']).toBe('flex');
    expect((card['contents'] as Node)['type']).toBe('bubble');
  });

  it('copies the digits-only number from one clipboard button', () => {
    const actions: Node[] = [];
    walk(bubble(), (n) => {
      if (n['type'] === 'button') actions.push(n['action'] as Node);
    });
    expect(actions).toEqual([
      {
        type: 'clipboard',
        label: 'คัดลอกเลขบัญชี',
        clipboardText: '1234567890',
      },
    ]);
  });

  it('prints the account in the card body so an old client without the clipboard action still shows it', () => {
    const body = texts((bubble() as { body: Node })['body']);
    expect(body).toContain('โอนให้ สมหญิง ใจดี');
    expect(body).toContain('กสิกรไทย');
    expect(body).toContain('123-4-56789-0');
  });

  it('has one row per person, in input order, with the amount right-aligned', () => {
    const rows = personRows();
    expect(rows.map((r) => r.name)).toEqual(['สมชาย', 'มาลี']);
    expect(rows.map((r) => r.amount['text'])).toEqual(['฿1,440', '฿85.50']);
    for (const r of rows) expect(r.amount['align']).toBe('end');
  });

  it('marks an absent person and shows a zero amount as ไม่ต้องโอน', () => {
    const rows = personRows({
      ...INPUT,
      rows: [
        { name: 'ต้อม', amountSatang: 0, absent: false },
        { name: 'นิด', amountSatang: 5000, absent: true },
      ],
    });
    expect(rows[0]?.amount['text']).toBe('ไม่ต้องโอน');
    expect(rows[0]?.amount['align']).toBe('end');
    expect(rows[1]?.name).toBe('นิด (ไม่มา)');
    expect(rows[1]?.amount['text']).toBe('฿50');
    expect(
      JSON.stringify(
        bubble({
          ...INPUT,
          rows: [{ name: 'ต้อม', amountSatang: 0, absent: false }],
        }),
      ),
    ).not.toContain('฿0');
  });

  it('shows the total and the date and venue rows', () => {
    const all = texts(bubble());
    expect(all).toContain('รวม');
    expect(all).toContain('฿1,525.50');
    expect(all).toContain('Bad@Mama');
    expect(all).toContain('วันที่');
    expect(all).toContain('29 ต.ค. 2569');
    expect(all).toContain('สนาม');
    const noVenue = texts(bubble({ ...INPUT, venue: '  ' }));
    expect(noVenue).not.toContain('สนาม');
  });

  it('shows the paid line only when someone has paid', () => {
    expect(
      texts(bubble({ ...INPUT, settledCount: 0 })).join('|'),
    ).not.toContain('จ่ายแล้ว');
    expect(texts(bubble({ ...INPUT, settledCount: 3 }))).toContain(
      'จ่ายแล้ว 3 คน',
    );
  });

  it('has no uri action, no summary link and no margin', () => {
    const json = JSON.stringify(paymentCardMessages(INPUT, 'host'));
    expect(json).not.toContain('"uri"');
    expect(json).not.toContain('ดูสรุป');
    expect(json).not.toMatch(/margin/i);
  });

  it('sets the alt text from the group name and the Thai date', () => {
    const [card] = paymentCardMessages(INPUT, 'group') as Node[];
    expect(card['altText']).toBe('ยอดค่าเล่น ตีชิล 29 ต.ค. 2569');
  });

  it('falls back to ก๊วน for a group with no name', () => {
    const [card] = paymentCardMessages(
      { ...INPUT, groupName: null },
      'group',
    ) as Node[];
    const header = (card['contents'] as { header: Node })['header'];
    expect(texts(header)).toEqual(['ยอดค่าเล่น', 'ก๊วน']);
    expect(card['altText']).toBe('ยอดค่าเล่น ก๊วน 29 ต.ค. 2569');
  });

  it('falls back to the end date in Bangkok time when the session has no date', () => {
    // 18:00 UTC on the 30th is already the 31st in Bangkok.
    const input = {
      ...INPUT,
      date: null,
      endedAt: new Date('2026-10-30T18:00:00Z'),
    };
    expect(texts(bubble(input))).toContain('31 ต.ค. 2569');
    const [card] = paymentCardMessages(input, 'group') as Node[];
    expect(card['altText']).toBe('ยอดค่าเล่น ตีชิล 31 ต.ค. 2569');
  });

  it('writes a blank or whitespace-only name as "-", never an empty text LINE would reject', () => {
    const rows = personRows({
      ...INPUT,
      rows: [
        { name: '', amountSatang: 100, absent: false },
        { name: '   ', amountSatang: 200, absent: true },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['-', '- (ไม่มา)']);
    for (const t of texts(
      paymentCardMessages(
        { ...INPUT, rows: [{ name: ' ', amountSatang: 100, absent: false }] },
        'host',
      ),
    )) {
      expect(t.trim()).not.toBe('');
    }
  });

  it('refuses to build a card with nobody to collect from', () => {
    expect(() => paymentCardMessages({ ...INPUT, rows: [] }, 'group')).toThrow(
      RangeError,
    );
  });

  it('clips every host-typed text to 60 characters without splitting an emoji', () => {
    const long = '😀'.repeat(80);
    const input: PaymentCardInput = {
      groupName: long,
      date: long,
      endedAt: INPUT.endedAt,
      venue: long,
      rows: [{ name: long, amountSatang: 100, absent: false }],
      settledCount: 0,
      totalSatang: 100,
      account: { bank: long, number: '123-4-56789-0', name: long },
    };
    const clipped = `${'😀'.repeat(59)}…`;
    const card = bubble(input) as {
      header: Node;
      body: Node;
    };
    // Header: label, group name. Body, in order: date, venue, the person, total, then the account block.
    expect(texts(card.header)).toEqual(['ยอดค่าเล่น', clipped]);
    expect(texts(card.body)).toEqual([
      'วันที่',
      clipped,
      'สนาม',
      clipped,
      clipped,
      '฿1',
      'รวม',
      '฿1',
      `โอนให้ ${clipped}`,
      clipped,
      '123-4-56789-0',
    ]);
    const [message] = paymentCardMessages(input, 'group') as Node[];
    expect(message['altText']).toBe(`ยอดค่าเล่น ${clipped} ${clipped}`);
    // A lone surrogate would make this round-trip lossy.
    const json = JSON.stringify(paymentCardMessages(input, 'group'));
    expect(JSON.parse(json)).toEqual(paymentCardMessages(input, 'group'));
    expect(json).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('stays under 30,000 bytes for 40 rows of 60-character Thai names', () => {
    const name = 'ก'.repeat(60);
    const rows = Array.from({ length: 40 }, () => ({
      name,
      amountSatang: 123456,
      absent: true,
    }));
    const json = JSON.stringify(
      paymentCardMessages({ ...INPUT, rows }, 'group'),
    );
    // LINE's Messaging API reference caps one Flex bubble at 30 KB (50 KB is the carousel limit).
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(30_000);
  });

  it('follows the card with the digits-only number as plain text when the constant says so', () => {
    for (const target of ['group', 'host'] as const) {
      const messages = paymentCardMessages(INPUT, target) as Node[];
      expect(messages).toHaveLength(PAYMENT_NUMBER_TEXT[target] ? 2 : 1);
      if (PAYMENT_NUMBER_TEXT[target]) {
        expect(messages[1]).toMatchObject({ type: 'text' });
        expect(messages[1]?.['text']).toContain('1234567890');
      }
    }
  });
});

describe('formatBaht', () => {
  it('writes whole baht without decimals and thousands with commas', () => {
    expect(formatBaht(144000)).toBe('1,440');
    expect(formatBaht(0)).toBe('0');
    expect(formatBaht(100)).toBe('1');
  });

  it('keeps two decimals for a part-baht amount', () => {
    expect(formatBaht(8550)).toBe('85.50');
    expect(formatBaht(5)).toBe('0.05');
  });

  it('puts the sign in front of a negative amount', () => {
    expect(formatBaht(-8550)).toBe('-85.50');
    expect(formatBaht(-144000)).toBe('-1,440');
  });
});

describe('liffPayUrl', () => {
  it('encodes the session code and keeps the token', () => {
    expect(liffPayUrl('1-a', 'abc 1', 'T_k-9')).toBe(
      'https://liff.line.me/1-a/pay/abc%201/T_k-9',
    );
  });
});
