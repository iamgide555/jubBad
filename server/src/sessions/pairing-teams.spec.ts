import { describe, expect, it } from 'vitest';
import {
  CorruptPairingError,
  emptySeatCount,
  parseSeatTeams,
  parseSeats,
  parseTeam,
  parseTeams,
  seatedPlayers,
  teamPlayers,
} from './pairing-teams.js';

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

  it('rejects a team with an unfilled seat', () => {
    expect(() => parseTeam('[null,"a"]')).toThrow(CorruptPairingError);
  });
});

describe('parseSeats', () => {
  it('parses a fully seated doubles team, same as parseTeam', () => {
    expect(parseSeats('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses a team with an unfilled seat', () => {
    expect(parseSeats('[null,"a"]')).toEqual([null, 'a']);
  });

  it('parses a team with every seat unfilled', () => {
    expect(parseSeats('[null,null]')).toEqual([null, null]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSeats('not json')).toThrow(CorruptPairingError);
  });

  it('rejects an empty array', () => {
    expect(() => parseSeats('[]')).toThrow(CorruptPairingError);
  });

  it('rejects a non-string, non-null entry', () => {
    expect(() => parseSeats('["a",1]')).toThrow(CorruptPairingError);
  });
});

describe('parseSeatTeams', () => {
  it('parses a court with a mix of filled and empty seats', () => {
    expect(parseSeatTeams({ teamA: '["a",null]', teamB: '["c","d"]' })).toEqual({
      teamA: ['a', null],
      teamB: ['c', 'd'],
    });
  });

  it('rejects mismatched team sizes even with empty seats', () => {
    expect(() => parseSeatTeams({ teamA: '[null]', teamB: '[null,"c"]' })).toThrow(
      CorruptPairingError
    );
  });
});

describe('seatedPlayers', () => {
  it('returns only the filled seats, teamA-then-teamB order', () => {
    expect(seatedPlayers({ teamA: '["a",null]', teamB: '[null,"d"]' })).toEqual(['a', 'd']);
  });

  it('returns every player when the court is full', () => {
    expect(seatedPlayers({ teamA: '["a","b"]', teamB: '["c","d"]' })).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('emptySeatCount', () => {
  it('counts unfilled seats across both teams', () => {
    expect(emptySeatCount({ teamA: '["a",null]', teamB: '[null,"d"]' })).toBe(2);
  });

  it('is zero for a fully seated court', () => {
    expect(emptySeatCount({ teamA: '["a","b"]', teamB: '["c","d"]' })).toBe(0);
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
