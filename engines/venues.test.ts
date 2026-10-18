import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVenueName, matchVenues, type VenueRef } from './venues.ts';

function venue(id: string, displayName: string): VenueRef {
  return { id, displayName, normalizedName: normalizeVenueName(displayName) };
}

test('normalizeVenueName lowercases and removes all whitespace', () => {
  assert.equal(normalizeVenueName('  K I P '), 'kip');
});

test('normalizeVenueName treats NFD and NFC Thai as the same name', () => {
  assert.equal(normalizeVenueName('สนามเก๊'), normalizeVenueName('สนามเก๊'.normalize('NFD')));
  assert.equal(normalizeVenueName('é'), normalizeVenueName('é'));
});

test('normalizeVenueName gives an empty string for whitespace only', () => {
  assert.equal(normalizeVenueName('   '), '');
});

test('matchVenues returns an exact match and does not repeat it in suggestions', () => {
  const kip = venue('1', 'KIP');
  const result = matchVenues('kip', [kip]);
  assert.equal(result.exact?.id, '1');
  assert.deepEqual(result.suggestions, []);
});

test('matchVenues suggests a similar name but never calls it exact', () => {
  const result = matchVenues('kipp', [venue('1', 'KIP')]);
  assert.equal(result.exact, null);
  assert.equal(result.suggestions[0]?.id, '1');
});

test('matchVenues finds a venue by prefix and leaves unrelated ones out', () => {
  const result = matchVenues('ki', [venue('1', 'KIP'), venue('2', 'Alpha')]);
  assert.deepEqual(result.suggestions.map((v) => v.id), ['1']);
});

test('matchVenues returns nothing for a blank query', () => {
  assert.deepEqual(matchVenues('   ', [venue('1', 'KIP')]), { exact: null, suggestions: [] });
});

test('matchVenues limits to 8 by default, substring matches first then ties by name', () => {
  const many = Array.from({ length: 20 }, (_, i) => venue(String(i), `Court ${String(i).padStart(2, '0')}`));
  const result = matchVenues('cour', many);
  assert.equal(result.suggestions.length, 8);
  assert.deepEqual(
    result.suggestions.map((v) => v.displayName),
    many.slice(0, 8).map((v) => v.displayName)
  );
  assert.equal(matchVenues('cour', many, 3).suggestions.length, 3);
});

test('matchVenues puts substring matches before similarity-only matches', () => {
  const result = matchVenues('mama', [venue('1', 'Mamba'), venue('2', 'Mama Badminton')]);
  assert.deepEqual(result.suggestions.map((v) => v.id), ['2', '1']);
});
