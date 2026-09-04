import { checkPairKey } from './engines-import-check';

describe('cross-boundary engine import', () => {
  it('can call a real function from the root-level pairing.ts', () => {
    expect(checkPairKey('b', 'a')).toBe('a|b');
  });
});
