import { describe, expect, it } from 'vitest';
import { CorruptPairingError, parseTeam, parseTeams, teamPlayers } from './pairing-teams.js';

describe('parseTeam', () => {
  it('parses a doubles team', () => {
    expect(parseTeam('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses a singles team', () => {
    expect(parseTeam('["a"]')).toEqual(['a']);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseTeam('not json')).toThrow(CorruptPairingError);
  });

  it('rejects an empty team', () => {
    expect(() => parseTeam('[]')).toThrow(CorruptPairingError);
  });

  it('rejects a team of three or more', () => {
    expect(() => parseTeam('["a","b","c"]')).toThrow(CorruptPairingError);
  });

  it('rejects a non-string entry', () => {
    expect(() => parseTeam('["a",1]')).toThrow(CorruptPairingError);
  });

  it('rejects a non-array value', () => {
    expect(() => parseTeam('"a"')).toThrow(CorruptPairingError);
  });
});

describe('parseTeams', () => {
  it('parses matching doubles teams', () => {
    expect(parseTeams({ teamA: '["a","b"]', teamB: '["c","d"]' })).toEqual({
      teamA: ['a', 'b'],
      teamB: ['c', 'd'],
    });
  });

  it('parses matching singles teams', () => {
    expect(parseTeams({ teamA: '["a"]', teamB: '["b"]' })).toEqual({
      teamA: ['a'],
      teamB: ['b'],
    });
  });

  it('rejects mismatched team sizes', () => {
    expect(() => parseTeams({ teamA: '["a"]', teamB: '["b","c"]' })).toThrow(CorruptPairingError);
  });
});

describe('teamPlayers', () => {
  it('returns every player in teamA-then-teamB order', () => {
    expect(teamPlayers({ teamA: '["a","b"]', teamB: '["c","d"]' })).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns two players for a singles pairing', () => {
    expect(teamPlayers({ teamA: '["a"]', teamB: '["b"]' })).toEqual(['a', 'b']);
  });
});
