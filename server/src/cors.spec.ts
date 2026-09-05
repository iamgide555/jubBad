import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from './cors.js';

describe('parseCorsOrigins', () => {
  it('returns true (permissive) when unset outside production', () => {
    expect(parseCorsOrigins(undefined, 'development')).toBe(true);
    expect(parseCorsOrigins(undefined, undefined)).toBe(true);
  });

  it('returns true (permissive) when blank outside production', () => {
    expect(parseCorsOrigins('', 'development')).toBe(true);
    expect(parseCorsOrigins('   ', 'development')).toBe(true);
  });

  it('allows no cross-origin caller when unset in production', () => {
    expect(parseCorsOrigins(undefined, 'production')).toEqual([]);
    expect(parseCorsOrigins('   ', 'production')).toEqual([]);
  });

  it('still honours an explicit list in production', () => {
    expect(parseCorsOrigins('https://jubbad.wongnok.dev', 'production')).toEqual([
      'https://jubbad.wongnok.dev',
    ]);
  });

  it('returns a single-origin array', () => {
    expect(parseCorsOrigins('https://jubbad.wongnok.dev')).toEqual([
      'https://jubbad.wongnok.dev',
    ]);
  });

  it('splits and trims a comma-separated list', () => {
    expect(parseCorsOrigins('https://a.example, https://b.example ,https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('drops empty entries from trailing commas', () => {
    expect(parseCorsOrigins('https://a.example,')).toEqual(['https://a.example']);
  });
});
