import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRosterMessage, rosterStaleness, messagesToPurge, STALE_WITHOUT_SESSION_MS } from './line-roster.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function emptyTemplate(): string {
  const slots = Array.from({ length: 20 }, (_, i) => `${i + 1}.`).join('\n');
  return `ก๊วนวันพฤหัส\n8/10/26\n19.00-21.00 น.\n\n${slots}`;
}

test('isRosterMessage accepts a roster with a date and time header', () => {
  assert.equal(isRosterMessage('ก๊วนวันพฤหัส 8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด\n3.'), true);
});

test('isRosterMessage accepts the empty weekly template', () => {
  assert.equal(isRosterMessage(emptyTemplate()), true);
});

test('isRosterMessage rejects ordinary chat', () => {
  assert.equal(isRosterMessage('ไปไหมคืนนี้'), false);
  assert.equal(isRosterMessage(''), false);
});

test('isRosterMessage rejects a single numbered reply and two numbered lines', () => {
  assert.equal(isRosterMessage('1. ok'), false);
  assert.equal(isRosterMessage('8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด'), false);
});

test('isRosterMessage rejects a numbered rules post with no date, venue or time', () => {
  assert.equal(isRosterMessage('กฎก๊วน\n1. มาตรงเวลา\n2. ห้ามเสียงดัง\n3. จ่ายเงินก่อนกลับ'), false);
});

test('isRosterMessage rejects a numbered list with a date line but only two slots', () => {
  assert.equal(isRosterMessage('8/10/26\n1. ตั้ม\n2. มด'), false);
});

test('rosterStaleness: posted before the last session ended is stale, after is fresh', () => {
  const ended = new Date('2026-10-08T14:00:00Z');
  const now = new Date('2026-10-09T10:00:00Z');
  assert.equal(rosterStaleness(new Date('2026-10-08T10:00:00Z'), ended, now), 'stale');
  assert.equal(rosterStaleness(new Date('2026-10-08T15:00:00Z'), ended, now), 'fresh');
});

test('rosterStaleness with no ended session: fresh under 7 days, stale after', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(rosterStaleness(new Date(now.getTime() - (6 * DAY + 23 * HOUR)), null, now), 'fresh');
  assert.equal(rosterStaleness(new Date(now.getTime() - (7 * DAY + HOUR)), null, now), 'stale');
  assert.equal(STALE_WITHOUT_SESSION_MS, 7 * DAY);
});

test('messagesToPurge returns everything beyond the newest 20', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `m${i}`,
    postedAt: new Date(now.getTime() - (24 - i) * HOUR),
  }));
  const purged = messagesToPurge(rows, now);
  assert.equal(purged.length, 5);
  assert.deepEqual(new Set(purged), new Set(['m0', 'm1', 'm2', 'm3', 'm4']));
});

test('messagesToPurge returns rows older than 30 days', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const rows = [
    { id: 'a', postedAt: new Date(now.getTime() - HOUR) },
    { id: 'b', postedAt: new Date(now.getTime() - 2 * HOUR) },
    { id: 'old', postedAt: new Date(now.getTime() - 31 * DAY) },
  ];
  assert.deepEqual(messagesToPurge(rows, now), ['old']);
});

test('messagesToPurge on an empty list returns an empty list', () => {
  assert.deepEqual(messagesToPurge([], new Date()), []);
});
