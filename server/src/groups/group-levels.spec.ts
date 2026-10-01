import { DEFAULT_LEVEL_LADDER } from '../../../engines/levels.ts';
import { LevelLadderCorruptError, parseGroupLadder, serializeGroupLadder } from './group-levels.js';

describe('group ladder', () => {
  it('null is the standard ladder: the eight built-in levels with their 900..1600 seeds and deterministic ids', () => {
    const l = parseGroupLadder(null);
    expect(l.mode).toBe('standard');
    expect(l.levels.map((x) => [x.id, x.name, x.startingElo])).toEqual([
      ['standard:BG', 'BG', 900], ['standard:N', 'N', 1000], ['standard:S', 'S', 1100], ['standard:P-', 'P-', 1200],
      ['standard:P', 'P', 1300], ['standard:P+', 'P+', 1400], ['standard:C', 'C', 1500], ['standard:B', 'B', 1600],
    ]);
    expect(l.levels.map((x) => x.name)).toEqual(DEFAULT_LEVEL_LADDER.map((x) => x.name));
  });

  it('a custom ladder round-trips with its ids, order and seeds', () => {
    const levels = [
      { id: 'a1', name: 'มือใหม่', startingElo: 1000 },
      { id: 'b2', name: 'กลาง', startingElo: 1200 },
    ];
    const l = parseGroupLadder(serializeGroupLadder(levels));
    expect(l).toEqual({ mode: 'custom', levels });
  });

  it('corrupt stored data errors instead of quietly falling back to the standard ladder', () => {
    const bad = (raw: string) => expect(() => parseGroupLadder(raw), raw).toThrow(LevelLadderCorruptError);
    bad('{not json');
    bad('{}');
    bad('[]');
    bad(JSON.stringify([{ id: 'a', name: 'x' }]));
    bad(JSON.stringify([{ id: '', name: 'x', startingElo: 1000 }]));
    bad(JSON.stringify([{ id: 'a', name: '', startingElo: 1000 }]));
    bad(JSON.stringify([{ id: 'a', name: 'x', startingElo: 1000.5 }]));
    bad(JSON.stringify([{ id: 'a', name: 'x', startingElo: 1000 }, { id: 'a', name: 'y', startingElo: 1100 }]));
    bad(JSON.stringify([{ id: 'a', name: 'x', startingElo: 1100 }, { id: 'b', name: 'y', startingElo: 1000 }]));
    bad(JSON.stringify([{ id: 'a', name: 'x', startingElo: 1000 }, { id: 'b', name: 'X', startingElo: 1100 }]));
  });

  it('refuses to serialize an invalid ladder', () => {
    expect(() => serializeGroupLadder([])).toThrow();
    expect(() => serializeGroupLadder([{ id: 'a', name: ' x', startingElo: 1000 }])).toThrow();
  });
});
