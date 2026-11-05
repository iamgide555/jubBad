import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playersNeedingRest, type PlayedGame } from './rest.ts';

const game = (players: string[], confirmedAt: number, endedAt: number | null): PlayedGame => ({
  players,
  confirmedAt,
  endedAt,
});

test('rest: two games in a row with nothing started between, fresh off court', () => {
  const games = [game(['a', 'b', 'c', 'd'], 0, 100), game(['a', 'e', 'f', 'g'], 110, 200)];
  assert.deepEqual([...playersNeedingRest(games)].sort(), ['a']);
});

test('rest: a game started while they sat means they rested', () => {
  const games = [
    game(['a', 'b', 'c', 'd'], 0, 100),
    game(['e', 'f', 'g', 'h'], 105, null),
    game(['a', 'i', 'j', 'k'], 110, 200),
  ];
  assert.equal(playersNeedingRest(games).has('a'), false);
});

test('rest: not fresh off court once another game has started since', () => {
  const games = [
    game(['a', 'b', 'c', 'd'], 0, 100),
    game(['a', 'e', 'f', 'g'], 110, 200),
    game(['h', 'i', 'j', 'k'], 210, null),
  ];
  assert.equal(playersNeedingRest(games).has('a'), false);
});

test('rest: one game played, or still on court, never needs rest', () => {
  const games = [game(['a', 'b', 'c', 'd'], 0, 100), game(['a', 'e', 'f', 'g'], 110, null)];
  assert.equal(playersNeedingRest(games).size, 0);
  assert.equal(playersNeedingRest([game(['a', 'b', 'c', 'd'], 0, 100)]).size, 0);
});

test('rest: order of input rows does not matter', () => {
  const games = [game(['a', 'e', 'f', 'g'], 110, 200), game(['a', 'b', 'c', 'd'], 0, 100)];
  assert.deepEqual([...playersNeedingRest(games)], ['a']);
});
