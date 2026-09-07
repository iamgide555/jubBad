import { LoginThrottle, MAX_ATTEMPTS, WINDOW_MS } from './login-throttle.js';

describe('LoginThrottle', () => {
  it('allows the first attempt from an address', () => {
    expect(new LoginThrottle().check('1.2.3.4')).toBe(true);
  });

  it('allows attempts up to the limit', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(t.check('1.2.3.4')).toBe(true);
      t.recordFailure('1.2.3.4');
    }
    expect(t.check('1.2.3.4')).toBe(false);
  });

  it('counts only failures, so a working login is never locked out', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      expect(t.check('1.2.3.4')).toBe(true);
    }
  });

  it('throttles each address separately', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < MAX_ATTEMPTS; i++) t.recordFailure('1.2.3.4');
    expect(t.check('1.2.3.4')).toBe(false);
    expect(t.check('5.6.7.8')).toBe(true);
  });

  it('forgets failures once the window has passed', () => {
    let now = 1_000_000;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < MAX_ATTEMPTS; i++) t.recordFailure('1.2.3.4');
    expect(t.check('1.2.3.4')).toBe(false);

    now += WINDOW_MS + 1;
    expect(t.check('1.2.3.4')).toBe(true);
  });

  it('clears an address after a successful login', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < MAX_ATTEMPTS; i++) t.recordFailure('1.2.3.4');
    expect(t.check('1.2.3.4')).toBe(false);

    t.recordSuccess('1.2.3.4');
    expect(t.check('1.2.3.4')).toBe(true);
  });

  it('does not grow without bound as addresses come and go', () => {
    let now = 1_000_000;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 500; i++) t.recordFailure(`10.0.0.${i}`);
    expect(t.size).toBe(500);

    // A later attempt from anywhere sweeps entries whose window has expired,
    // so a long-running server does not accumulate an entry per attacker IP.
    now += WINDOW_MS + 1;
    t.check('1.2.3.4');
    expect(t.size).toBe(0);
  });
});
