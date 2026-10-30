import { describe, expect, it } from 'vitest';
import {
  amountPresent,
  hasAmountToken,
  owedAmountsFound,
  receiverName,
  receiverNameMatches,
  receiverTail,
  type OcrLine,
} from './slip-match.js';

function lines(...texts: string[]): OcrLine[] {
  return texts.map((text, i) => ({ text, y0: i * 100, y1: i * 100 + 60 }));
}

const TWO_NAMES = lines(
  'โอนเงินสำเร็จ',
  'นาย ธนัช อ.',
  'ธนาคารกสิกรไทย',
  'น.ส. จิตติญา ฉัตรเฉลิมวิทย์',
  'xxx-xxx-5953',
);

describe('amountPresent', () => {
  it('finds a whole amount token', () => {
    expect(amountPresent('จำนวนเงิน 172.00 บาท', 17200)).toBe(true);
  });

  it('does not find 172.00 inside 1172.00', () => {
    expect(amountPresent('จำนวนเงิน 1172.00 บาท', 17200)).toBe(false);
  });

  it('finds a comma-grouped amount', () => {
    expect(amountPresent('1,172.00', 117200)).toBe(true);
  });

  it('requires exactly two decimals', () => {
    expect(amountPresent('172.0', 17200)).toBe(false);
    expect(amountPresent('172.000', 17200)).toBe(false);
  });

  it('does not match inside a longer dotted number', () => {
    expect(amountPresent('1.172.00', 17200)).toBe(false);
  });

  it('never treats zero as present', () => {
    expect(amountPresent('0.00', 0)).toBe(false);
  });
});

describe('hasAmountToken', () => {
  it('is true for any whole amount token, plain or comma-grouped', () => {
    expect(hasAmountToken('จำนวนเงิน 172.00 บาท')).toBe(true);
    expect(hasAmountToken('1,172.00')).toBe(true);
    expect(hasAmountToken('ค่าธรรมเนียม 0.00 บาท')).toBe(true);
  });

  it('is false when no number has exactly two decimals', () => {
    expect(hasAmountToken('')).toBe(false);
    expect(hasAmountToken('โอนเงินสำเร็จ 30 ต.ค. 69 21:04')).toBe(false);
    expect(hasAmountToken('172 บาท')).toBe(false);
    expect(hasAmountToken('172.0 / 172.000')).toBe(false);
  });

  it('follows the same glue rules as amountPresent', () => {
    expect(hasAmountToken('1.172.00')).toBe(false);
    expect(hasAmountToken('172.00.5')).toBe(false);
  });
});

describe('owedAmountsFound', () => {
  it('returns the distinct owed amounts present', () => {
    expect(owedAmountsFound('172.00 ... 150.00', [17200, 15000, 9900])).toEqual(
      [17200, 15000],
    );
  });

  it('deduplicates repeated owed values', () => {
    expect(owedAmountsFound('172.00', [17200, 17200])).toEqual([17200]);
  });
});

describe('receiverNameMatches', () => {
  it('matches the receiver (lowest name block)', () => {
    expect(receiverNameMatches(TWO_NAMES, 'จิตติญา')).toBe(true);
  });

  it('does not match when the host is the sender', () => {
    expect(receiverNameMatches(TWO_NAMES, 'ธนัช')).toBe(false);
  });

  it('rejects a short saved name that is only part of a receiver word', () => {
    const l = lines('นาย ธนัช อ.', 'น.ส. ภัคชนก');
    expect(receiverNameMatches(l, 'นก')).toBe(false);
  });

  it('tolerates a one-character misread on a long word', () => {
    const l = lines('นาย ธนัช อ.', 'น.ส. จิตติญา ฉัตรเฉลิมวิทย');
    expect(receiverNameMatches(l, 'จิตติญา ฉัตรเฉลิมวิทย์')).toBe(true);
  });

  it('allows no tolerance on a four-character word', () => {
    const l = lines('นาย ธนัช อ.', 'น.ส. ต้อง');
    expect(receiverNameMatches(l, 'ต้อม')).toBe(false);
  });

  it('requires every saved word to be present', () => {
    expect(receiverNameMatches(TWO_NAMES, 'จิตติญา สมศรี')).toBe(false);
  });

  it('accepts a lone titled line below an untitled sender', () => {
    const l = lines('Somchai K.', 'น.ส. จิตติญา');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(true);
  });

  it('rejects a lone titled line labelled จาก', () => {
    const l = lines('จาก', 'น.ส. จิตติญา');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(false);
  });

  it('rejects a lone titled line with จาก as its prefix', () => {
    const l = lines('จาก น.ส. จิตติญา');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(false);
  });

  it('rejects a lone titled line preceded by From (any case)', () => {
    const l = lines('FROM', 'Ms. Somying');
    expect(receiverNameMatches(l, 'Somying')).toBe(false);
  });

  it('rejects a slip with no titled line', () => {
    const l = lines('จิตติญา', 'ธนัช');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(false);
  });

  it('rejects a saved name made only of tiny words', () => {
    const l = lines('นาย ธนัช อ.', 'น.ส. นก ศรี');
    expect(receiverNameMatches(l, 'นก')).toBe(false);
  });

  it('rejects an empty saved name', () => {
    expect(receiverNameMatches(TWO_NAMES, '')).toBe(false);
    expect(receiverNameMatches(TWO_NAMES, '  ')).toBe(false);
  });

  it('drops a title from the saved name', () => {
    expect(receiverNameMatches(TWO_NAMES, 'น.ส. จิตติญา')).toBe(true);
  });

  it('survives icon noise before the title and orders by y0', () => {
    const l: OcrLine[] = [
      { text: '© น.ส. จิตติญา', y0: 500, y1: 560 },
      { text: 'นาย ธนัช อ.', y0: 100, y1: 160 },
    ];
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(true);
    expect(receiverNameMatches(l, 'ธนัช')).toBe(false);
  });

  it('finds the title after OCR noise and a "to" label on the line', () => {
    const l = lines(
      'an   @   น.ส.ภัคชนก',
      'ไปที่ Q® น.ส.จิตติญา ฉัตรเฉลิมวิทย์',
    );
    expect(receiverName(l)).toBe('จิตติญา ฉัตรเฉลิมวิทย์');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(true);
    expect(receiverNameMatches(l, 'จิตติญา ฉัตรเฉลิมวิทย์')).toBe(true);
  });

  it('still rejects the sender when noise precedes both titles', () => {
    const l = lines(
      'จาก   @   นาย ธนัช อ.',
      "ไปยัง 0 ' น.ส. จิตติญา ฉัตรเฉลิมวิทย์",
    );
    expect(receiverNameMatches(l, 'ธนัช')).toBe(false);
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(true);
  });

  it('rejects a lone name line with จาก before the title on the same line', () => {
    expect(receiverNameMatches(lines('จาก @ น.ส. จิตติญา'), 'จิตติญา')).toBe(
      false,
    );
  });

  it('does not read นางสาว as นาง', () => {
    const l = lines('นาย ธนัช อ.', 'นางสาว จิตติญา');
    expect(receiverName(l)).toBe('จิตติญา');
    expect(receiverNameMatches(l, 'จิตติญา')).toBe(true);
  });
});

describe('receiverName', () => {
  it('returns the lowest name block without its title', () => {
    expect(receiverName(TWO_NAMES)).toBe('จิตติญา ฉัตรเฉลิมวิทย์');
  });

  it('is null when there is no name line', () => {
    expect(receiverName(lines('จำนวนเงิน', '172.00'))).toBeNull();
  });

  it('is null for a lone titled line labelled จาก', () => {
    expect(receiverName(lines('จาก', 'น.ส. จิตติญา'))).toBeNull();
  });
});

describe('receiverTail', () => {
  it('reads the last four digits of a masked number', () => {
    expect(receiverTail('xxx-xxx-5953')).toBe('5953');
    expect(receiverTail('062-xxx-5953')).toBe('5953');
    expect(receiverTail('เลขบัญชี XXX-X-XX595-3')).toBe('5953');
  });

  it('accepts OCR-read mask characters', () => {
    expect(receiverTail('062-%%%-5953')).toBe('5953');
    expect(receiverTail('xxx-***-5953')).toBe('5953');
    expect(receiverTail('062-•••-5953')).toBe('5953');
  });

  it('prefers the lowest masked number (receiver below sender)', () => {
    expect(receiverTail('XXX-XXX-1698\nXXX-XXX-5953')).toBe('5953');
  });

  it('is null without a masked number', () => {
    expect(receiverTail('no digits')).toBeNull();
    expect(receiverTail('123-456-7890')).toBeNull();
  });
});
