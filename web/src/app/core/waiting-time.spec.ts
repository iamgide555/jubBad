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
});
