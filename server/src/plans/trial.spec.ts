import { TRIAL_DAYS, TRIAL_PLAN, trialRenewsAt } from './trial.js';

describe('trialRenewsAt', () => {
  it('ends at the last millisecond of the Bangkok day 30 days later', () => {
    // 16 Nov 2026, 10:00 in Bangkok
    expect(trialRenewsAt(new Date('2026-11-16T03:00:00Z')).toISOString()).toBe('2026-12-16T16:59:59.999Z');
  });

  it('counts the Bangkok day, not the UTC day, just after midnight in Bangkok', () => {
    // 17 Nov 2026, 00:30 in Bangkok is still 16 Nov in UTC
    expect(trialRenewsAt(new Date('2026-11-16T17:30:00Z')).toISOString()).toBe('2026-12-17T16:59:59.999Z');
  });

  it('counts the Bangkok day just before midnight in Bangkok', () => {
    // 16 Nov 2026, 23:30 in Bangkok
    expect(trialRenewsAt(new Date('2026-11-16T16:30:00Z')).toISOString()).toBe('2026-12-16T16:59:59.999Z');
  });

  it('is the Host plan for 30 days', () => {
    expect(TRIAL_PLAN).toBe('host');
    expect(TRIAL_DAYS).toBe(30);
  });
});
