import { describe, expect, it } from 'vitest';
import { effectiveCourtMode, isCustomMode, isLevelMode, SESSION_MODES } from './session-mode.js';

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

describe('effectiveCourtMode', () => {
  it('returns the session mode directly when the session is not custom', () => {
    expect(effectiveCourtMode({ mode: 'level', courtModes: '["variety"]' }, 1)).toBe('level');
    expect(effectiveCourtMode({ mode: 'balanced', courtModes: null }, 1)).toBe('balanced');
  });

  it('reads the court-specific entry when the session is custom', () => {
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level","balanced"]' }, 1)).toBe(
      'level'
    );
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level","balanced"]' }, 2)).toBe(
      'balanced'
    );
  });

  it('defaults an untouched court to custom while the session is custom', () => {
    expect(effectiveCourtMode({ mode: 'custom', courtModes: null }, 1)).toBe('custom');
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level"]' }, 5)).toBe('custom');
  });
});
