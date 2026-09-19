import { describe, expect, it } from 'vitest';
import { isCustomMode, SESSION_MODES } from './session-mode.js';

describe('SESSION_MODES', () => {
  it('names the three pairing modes, variety first as the default', () => {
    expect(SESSION_MODES).toEqual(['variety', 'balanced', 'custom']);
  });
});

describe('isCustomMode', () => {
  it('is true for custom', () => {
    expect(isCustomMode('custom')).toBe(true);
  });

  it('is false for variety and balanced', () => {
    expect(isCustomMode('variety')).toBe(false);
    expect(isCustomMode('balanced')).toBe(false);
  });
});
