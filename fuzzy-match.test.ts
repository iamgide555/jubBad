import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, levenshteinDistance, similarity } from './fuzzy-match.ts';

test('normalizeName strips a trailing (...) note', () => {
  assert.equal(normalizeName('พี่แวน(พี่ที่ทำงานไกด์)'), 'พี่แวน');
});

test('normalizeName trims surrounding whitespace', () => {
  assert.equal(normalizeName('  ตั้ม  '), 'ตั้ม');
});

test('normalizeName applies Unicode NFC', () => {
  // 'e' + combining acute accent (U+0301) -> precomposed 'é' (U+00E9)
  assert.equal(normalizeName('é'), 'é');
});

test('levenshteinDistance is 0 for identical strings', () => {
  assert.equal(levenshteinDistance('ตั้ม', 'ตั้ม'), 0);
});

test('levenshteinDistance counts one substitution', () => {
  assert.equal(levenshteinDistance('ตั้ม', 'ตัม'), 1);
});

test('levenshteinDistance counts appended characters', () => {
  // real example from PROJECT.md §6.2: เกีย -> เกียร์ is 2 chars appended (ร, ์)
  assert.equal(levenshteinDistance('เกีย', 'เกียร์'), 2);
});

test('levenshteinDistance handles an empty string', () => {
  assert.equal(levenshteinDistance('', 'abc'), 3);
  assert.equal(levenshteinDistance('abc', ''), 3);
});

test('similarity is 1 for identical strings', () => {
  assert.equal(similarity('ตั้ม', 'ตั้ม'), 1);
});

test('similarity of a one-char-off pair clears the 0.7 threshold', () => {
  // ตั้ม vs ตัม: distance 1, maxLen 4 -> 0.75
  assert.equal(similarity('ตั้ม', 'ตัม'), 0.75);
});

test('similarity of เกีย vs เกียร์ falls below the 0.7 threshold', () => {
  // distance 2, maxLen 6 -> 0.6667 — PROJECT.md §6.2 calls these distinct players
  assert.ok(similarity('เกีย', 'เกียร์') < 0.7);
});

test('similarity handles two empty strings', () => {
  assert.equal(similarity('', ''), 1);
});
