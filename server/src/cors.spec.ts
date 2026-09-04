import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from './cors.js';

describe('parseCorsOrigins', () => {
  it('returns true (permissive) when unset', () => {
    expect(parseCorsOrigins(undefined)).toBe(true);
  });

  it('returns true (permissive) when blank', () => {
    expect(parseCorsOrigins('')).toBe(true);
    expect(parseCorsOrigins('   ')).toBe(true);
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
