import { elapsedSeconds, formatClock, formatMinutes } from './game-duration';

describe('elapsedSeconds', () => {
  it('measures from startedAt to now', () => {
    expect(elapsedSeconds('2026-09-08T12:00:00.000Z', new Date('2026-09-08T12:12:07.000Z').getTime())).toBe(
      727
    );
  });

  it('clamps a future start (clock skew) to 0', () => {
    expect(elapsedSeconds('2026-09-08T12:00:10.000Z', new Date('2026-09-08T12:00:00.000Z').getTime())).toBe(
      0
    );
  });
});

describe('formatClock', () => {
  it('pads seconds but not minutes', () => {
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(727)).toBe('12:07');
  });

  it('keeps counting minutes past an hour instead of rolling to H:MM:SS', () => {
    expect(formatClock(72 * 60 + 14)).toBe('72:14');
  });

  it('clamps a negative value to 0:00', () => {
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('formatMinutes', () => {
  it('floors to whole minutes', () => {
    expect(formatMinutes(719)).toBe('11 น.');
  });

  it('splits into hours and minutes past an hour', () => {
    expect(formatMinutes(8220)).toBe('2 ชม. 17 น.');
  });

  it('clamps a negative value to 0 minutes', () => {
    expect(formatMinutes(-5)).toBe('0 น.');
  });
});
