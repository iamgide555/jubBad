import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName } from './fuzzy-match.ts';

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
