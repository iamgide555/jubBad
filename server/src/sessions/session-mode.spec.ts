import { describe, expect, it } from 'vitest';
import { isCustomMode, isLevelMode, SESSION_MODES } from './session-mode.js';

describe('SESSION_MODES', () => {
  it('names the four pairing modes, variety first as the default', () => {
    expect(SESSION_MODES).toEqual(['variety', 'balanced', 'level', 'custom']);
  });
});

describe('isCustomMode', () => {
  it('is true for custom', () => {
    expect(isCustomMode('custom')).toBe(true);
  });

  it('is false for variety, balanced and level', () => {
    expect(isCustomMode('variety')).toBe(false);
    expect(isCustomMode('balanced')).toBe(false);
    expect(isCustomMode('level')).toBe(false);
  });
});

describe('isLevelMode', () => {
  it('is true for level', () => {
    expect(isLevelMode('level')).toBe(true);
  });

  it('is false for variety, balanced and custom', () => {
    expect(isLevelMode('variety')).toBe(false);
    expect(isLevelMode('balanced')).toBe(false);
    expect(isLevelMode('custom')).toBe(false);
  });
});
