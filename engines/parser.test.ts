import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineRosterMessage } from './parser.ts';

const TYPICAL = `@All
แบดวินนิ่ง อังคาร 8/9/26
19.00-20.00  1 คอร์ท
20.00-22.00  3 คอร์ท 10+11+12
1. ตั้ม
2. เบส
3.
สำรอง
1. ปอม
`;

test('parseLineRosterMessage reads the header of a typical message', () => {
  const result = parseLineRosterMessage(TYPICAL);
  assert.equal(result.header.isoDate, '2026-09-08');
  assert.equal(result.header.titleLine, 'แบดวินนิ่ง อังคาร 8/9/26');
  assert.deepEqual(
    result.header.timeSlots.map((s) => s.raw),
    ['19.00-20.00', '20.00-22.00']
  );
});

test('parseLineRosterMessage keeps an empty numbered slot as a null name', () => {
  const result = parseLineRosterMessage(TYPICAL);
  assert.deepEqual(result.roster, [
    { position: 1, name: 'ตั้ม' },
    { position: 2, name: 'เบส' },
    { position: 3, name: null },
  ]);
});

test('parseLineRosterMessage reads the waitlist after the สำรอง marker', () => {
  const result = parseLineRosterMessage(TYPICAL);
  assert.deepEqual(result.waitlist, [{ position: 1, name: 'ปอม' }]);
});

test('parseLineRosterMessage warns rather than guessing when there is no date', () => {
  const result = parseLineRosterMessage('19.00-20.00  1 คอร์ท\n1. ตั้ม\n');
  assert.ok(result.warnings.some((w) => w.includes('No date')));
});

/**
 * TIME_RANGE_RE is a /g regex, so `.test()` advances its lastIndex. A second
 * time-range line that matches earlier in its own string than the previous
 * line's lastIndex is then missed entirely. Here that made the parser mistake
 * "1.00-3.00  3 คอร์ท" for roster entry number 1: the roster start landed on
 * the time line, the block broke on it immediately, and both real names were
 * dropped with no warning at all.
 */
test('a second consecutive time-range line is not mistaken for roster entry 1', () => {
  const result = parseLineRosterMessage(`@All
แบดวินนิ่ง เสาร์ 8/9/26
11.00-13.00  2 คอร์ท
1.00-3.00  3 คอร์ท
1. ตั้ม
2. เบส
`);
  assert.deepEqual(result.roster, [
    { position: 1, name: 'ตั้ม' },
    { position: 2, name: 'เบส' },
  ]);
  assert.deepEqual(
    result.header.timeSlots.map((s) => s.raw),
    ['11.00-13.00', '1.00-3.00']
  );
});

test('parsing is not affected by what a previous call left behind', () => {
  const endsOnATimeLine = '1. ตั้ม\n19.00-20.00  1 คอร์ท\n';
  const message = '1.00-3.00  2 คอร์ท\n1. ตั้ม\n2. เบส\n';

  const clean = parseLineRosterMessage(message);
  parseLineRosterMessage(endsOnATimeLine);
  const afterOtherParse = parseLineRosterMessage(message);

  assert.deepEqual(afterOtherParse, clean);
  assert.deepEqual(afterOtherParse.roster, [
    { position: 1, name: 'ตั้ม' },
    { position: 2, name: 'เบส' },
  ]);
});

test('unclassifiable trailing lines are surfaced, never dropped', () => {
  const result = parseLineRosterMessage('1. ตั้ม\nหมายเหตุ จ่ายเงินก่อนเล่น\n');
  assert.deepEqual(result.unrecognizedLines, ['หมายเหตุ จ่ายเงินก่อนเล่น']);
});
