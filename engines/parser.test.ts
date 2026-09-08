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
  assert.ok(result.warnings.some((warning) => warning.includes('ambiguous two-digit year')));
  assert.equal(result.header.titleLine, 'แบดวินนิ่ง อังคาร 8/9/26');
  assert.deepEqual(
    result.header.timeSlots.map((s) => s.raw),
    ['19.00-20.00', '20.00-22.00']
  );
});

test('parses real Gregorian and Buddhist-era calendar dates', () => {
  assert.equal(
    parseLineRosterMessage('Badminton 29/2/2024\n1. A').header.isoDate,
    '2024-02-29'
  );
  assert.equal(
    parseLineRosterMessage('Badminton 29/2/2567\n1. A').header.isoDate,
    '2024-02-29'
  );
});

test('warns and leaves impossible calendar dates unresolved', () => {
  const result = parseLineRosterMessage('Badminton 31/02/2026\n1. A');
  assert.equal(result.header.isoDate, null);
  assert.ok(result.warnings.some((warning) => warning.includes('not a real calendar date')));
});

test('does not use a numbered @All notification as a roster entry', () => {
  const result = parseLineRosterMessage(`1. @All
Badminton 8/9/2026
19.00-20.00
1. A
2. B`);
  assert.deepEqual(result.roster, [
    { position: 1, name: 'A' },
    { position: 2, name: 'B' },
  ]);
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

test('notes above the roster are surfaced too, not only the ones below it', () => {
  // Everything before the first numbered line was read for a date, a time and
  // a venue and then discarded, so a note written above the list vanished
  // while the same note below it was surfaced. Hosts put the court fee up
  // there, and it disappeared with nothing to indicate it ever existed.
  const result = parseLineRosterMessage(
    [
      '@All',
      'แบดวินนิ่ง อังคาร 8/9/26',
      '19.00-20.00  1 คอร์ท',
      'ค่าสนามคนละ 80 บาท',
      'ใครมาสายบอกด้วยนะ',
      '1. ตั้ม',
      '2. เบส',
    ].join('\n')
  );

  assert.deepEqual(result.unrecognizedLines, ['ค่าสนามคนละ 80 บาท', 'ใครมาสายบอกด้วยนะ']);
  // The title, the time line and the mention are all understood, so none of
  // them should be reported as leftovers.
  assert.equal(result.header.titleLine, 'แบดวินนิ่ง อังคาร 8/9/26');
  assert.deepEqual(result.roster, [
    { position: 1, name: 'ตั้ม' },
    { position: 2, name: 'เบส' },
  ]);
});

test('a name above the roster start is surfaced rather than swallowed', () => {
  // A list whose numbering does not reach 1 until part-way down: the earlier
  // entries fall in the header slice, and a real name there must not vanish.
  //
  // Note the deliberate title line. With no title at all the stray name
  // becomes the title itself, because the title heuristic takes the first line
  // that is not a mention or a time range. That is still surfaced to the host
  // rather than lost, which is what matters here, so the heuristic is left
  // alone — a message with no title is not a shape these groups send.
  const result = parseLineRosterMessage('แบดวินนิ่ง 8/9/26\n2. เกียร์\n1. ตั้ม\n');
  assert.deepEqual(result.unrecognizedLines, ['2. เกียร์']);
  assert.deepEqual(result.roster, [{ position: 1, name: 'ตั้ม' }]);
});

test('warns when the court count changes between time slots', () => {
  const result = parseLineRosterMessage(TYPICAL);
  const warning = result.warnings.find((w) => w.includes('court count changes'));
  assert.ok(warning, 'expected a warning about the changing court count');
  assert.ok(warning.includes('19.00-20.00 → 1 courts'));
  assert.ok(warning.includes('20.00-22.00 → 3 courts'));
  // The first slot is still what the session starts on — the warning tells the
  // host to adjust later, it does not guess a number for them.
  assert.equal(result.header.timeSlots[0].courtCount, 1);
});

test('does not warn when every slot books the same number of courts', () => {
  const result = parseLineRosterMessage(
    '19.00-20.00  2 คอร์ท\n20.00-22.00  2 คอร์ท\n1. ตั้ม\n'
  );
  assert.equal(
    result.warnings.some((w) => w.includes('court count changes')),
    false
  );
});
