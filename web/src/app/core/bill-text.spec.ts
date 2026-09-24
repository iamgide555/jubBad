import { buildBillText, formatBaht } from './bill-text';
import type { BillResponse, BillRow } from './bill.model';

const row = (playerId: string, games: number, amountSatang: number, walkIn = false): BillRow => ({
  playerId, games, status: 'billed', added: false, walkIn, courtSatang: 0, shuttleSatang: 0, baseSatang: 0,
  hostFeeSatang: 0, walkInFeeSatang: walkIn ? 2000 : 0, walkInDiscountSatang: 0, overridden: false, amountSatang,
});

function bill(overrides: Partial<BillResponse['config']> = {}): BillResponse {
  return {
    session: { code: 's', date: 'อ. 22 ก.ย.', venue: 'สนาม A', endedAt: null, shuttleCount: 18, shuttlePriceSatang: 8500 },
    config: {
      model: 'fair', courtFeeSatang: 144000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
      entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, hostFeeSatang: 1000,
      walkInFeeSatang: 2000, roundingBaht: 1, addedIds: [], removedIds: [], overrides: [], ...overrides,
    },
    configSource: 'saved',
    players: [
      { playerId: 'p', name: 'ปอม', games: 9, walkIn: false },
      { playerId: 'b', name: 'บอย', games: 5, walkIn: true },
    ],
    result: {
      rows: [row('b', 5, 21000, true), row('p', 9, 22500)],
      totals: { collectedSatang: 43500, costSatang: null, marginSatang: null, billedCount: 2, walkInCount: 1 },
      warnings: [],
    },
  };
}

describe('formatBaht', () => {
  it('adds thousands separators and keeps satang only when non-zero', () => {
    expect(formatBaht(144000)).toBe('1,440');
    expect(formatBaht(8550)).toBe('85.50');
    expect(formatBaht(0)).toBe('0');
  });

  it('handles a negative margin', () => {
    expect(formatBaht(-1500)).toBe('-15');
  });
});

describe('buildBillText', () => {
  it('fair pay with host fee and one walk-in', () => {
    expect(buildBillText(bill())).toBe(
      [
        '💰 ค่าก๊วน อ. 22 ก.ย. — สนาม A',
        'ค่าคอร์ท 1,440฿ หารเท่า 2 คน',
        'ค่าลูก 18 ลูก × 85฿ ตามจำนวนเกม',
        'ค่าจัดก๊วน 10฿/คน (รวมในยอดแล้ว)',
        'Walk-in +20฿/คน × 1 คน (หารคืนทุกคน)',
        'ปอม  9 เกม  225฿',
        'บอย  5 เกม  210฿ (walk-in)',
        'รวม 435฿',
      ].join('\n')
    );
  });

  it('per game header with entry and cap; no shuttle line', () => {
    const text = buildBillText(bill({ model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 8000, capSatang: 30000, hostFeeSatang: 0 }));
    expect(text).toContain('เกมละ 50฿ (+ค่าเข้า 80฿, สูงสุด 300฿)');
    expect(text).not.toContain('ค่าลูก');
  });

  it('buffet included; walk-in line hidden when fee is 0', () => {
    const b = bill({ model: 'buffet', buffetPriceSatang: 18000, walkInFeeSatang: 0, hostFeeSatang: 0 });
    const text = buildBillText(b);
    expect(text).toContain('บุฟเฟ่ต์ 180฿/คน (รวมลูก)');
    expect(text).not.toContain('Walk-in');
  });

  it('quotes the walk-in fee actually charged, not the configured one', () => {
    // 15฿ configured at 10฿ rounding: the engine charges 20฿ (a whole step).
    const b = bill({ walkInFeeSatang: 1500, roundingBaht: 10 });
    b.result.rows[0] = { ...b.result.rows[0], walkInFeeSatang: 2000 };
    const text = buildBillText(b);
    expect(text).toContain('Walk-in +20฿/คน × 1 คน (หารคืนทุกคน)');
    expect(text).not.toContain('+15฿');
  });

  it('omits removed rows and a missing venue', () => {
    const b = bill();
    b.session.venue = null;
    b.result.rows[0] = { ...b.result.rows[0], status: 'removed' };
    const text = buildBillText(b);
    expect(text.split('\n')[0]).toBe('💰 ค่าก๊วน อ. 22 ก.ย.');
    expect(text).not.toContain('บอย');
  });
});
