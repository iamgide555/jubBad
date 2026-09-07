import { buildWaitingList, minutesWaiting } from './waiting-time';

const START = '2026-09-08T12:00:00.000Z';
const NOW = new Date('2026-09-08T12:30:00.000Z').getTime();

describe('minutesWaiting', () => {
  it('counts from the session start when the player has not played', () => {
    expect(minutesWaiting('p1', {}, START, NOW)).toBe(30);
  });

  it('counts from their last finished match when they have', () => {
    expect(
      minutesWaiting('p1', { p1: '2026-09-08T12:20:00.000Z' }, START, NOW)
    ).toBe(10);
  });

  it('floors to whole minutes', () => {
    expect(
      minutesWaiting('p1', { p1: '2026-09-08T12:29:30.000Z' }, START, NOW)
    ).toBe(0);
  });

  it('measures a late arrival from when they joined, not the session start', () => {
    // The session began 30 minutes ago; they walked in 5 minutes ago.
    expect(
      minutesWaiting('p1', {}, START, NOW, { p1: '2026-09-08T12:25:00.000Z' })
    ).toBe(5);
  });

  it('uses the later of joining and their last match', () => {
    // Joined 20 minutes ago and has played since, so the match is what counts.
    expect(
      minutesWaiting(
        'p1',
        { p1: '2026-09-08T12:25:00.000Z' },
        START,
        NOW,
        { p1: '2026-09-08T12:10:00.000Z' }
      )
    ).toBe(5);
  });

  it('ignores an activation recorded before the session started', () => {
    expect(
      minutesWaiting('p1', {}, START, NOW, { p1: '2026-09-08T11:00:00.000Z' })
    ).toBe(30);
  });

  it('never reports a negative wait when a clock runs ahead', () => {
    expect(
      minutesWaiting('p1', { p1: '2026-09-08T12:45:00.000Z' }, START, NOW)
    ).toBe(0);
  });
});

describe('buildWaitingList', () => {
  it('puts the longest wait first', () => {
    const list = buildWaitingList(
      ['p1', 'p2'],
      ['ตั้ม', 'เบส'],
      { p1: '2026-09-08T12:25:00.000Z' },
      START,
      NOW
    );
    expect(list.map((e) => e.name)).toEqual(['เบส', 'ตั้ม']);
    expect(list[0].minutes).toBe(30);
    expect(list[1].minutes).toBe(5);
  });

  it('is empty when nobody is waiting', () => {
    expect(buildWaitingList([], [], {}, START, NOW)).toEqual([]);
  });

  /**
   * Finding 30: this list is a queue, so it has to be the order the engine
   * actually selects in — fewest games first, longest wait only to break ties.
   * Sorting on wait alone put the longest-waiting player on top even when they
   * had already played the most and would be picked last.
   */
  it('orders by games played before waiting time', () => {
    const list = buildWaitingList(
      ['played-lots', 'fresh'],
      ['ตั้ม', 'เบส'],
      // 'ตั้ม' has waited the longest, but has also played the most.
      { 'played-lots': '2026-09-08T12:10:00.000Z', fresh: '2026-09-08T12:45:00.000Z' },
      START,
      NOW,
      {},
      { 'played-lots': 4, fresh: 1 }
    );
    expect(list.map((e) => e.name)).toEqual(['เบส', 'ตั้ม']);
  });

  it('falls back to longest wait first when games are level', () => {
    const list = buildWaitingList(
      ['p1', 'p2'],
      ['ตั้ม', 'เบส'],
      { p1: '2026-09-08T12:25:00.000Z' },
      START,
      NOW,
      {},
      { p1: 2, p2: 2 }
    );
    expect(list.map((e) => e.name)).toEqual(['เบส', 'ตั้ม']);
  });
});
