import { applicableRules, enabledRules, parseDisabledRuleIds } from './session-rules.js';

const rule = (id: string, a: string, b: string) => ({ id, playerAId: a, playerBId: b, kind: 'must-pair' });

describe('session rule helpers', () => {
  it('session rule: null and an empty list mean nothing disabled', () => {
    expect(parseDisabledRuleIds(null)).toEqual([]);
    expect(parseDisabledRuleIds('[]')).toEqual([]);
    expect(parseDisabledRuleIds('["r1","r2"]')).toEqual(['r1', 'r2']);
  });

  it('session rule: a malformed non-null list throws instead of silently enabling nothing', () => {
    for (const raw of ['{', '{"r1":true}', '"r1"', '[1]', '[""]', '["r1","r1"]', 'null']) {
      expect(() => parseDisabledRuleIds(raw), raw).toThrow();
    }
  });

  it('session rule: enabledRules drops disabled ids and ignores unknown ones', () => {
    const rules = [rule('r1', 'a', 'b'), rule('r2', 'c', 'd')];
    expect(enabledRules(rules, ['r2', 'gone']).map((r) => r.id)).toEqual(['r1']);
  });

  it('session rule: applicableRules keeps only rules whose two players are both active', () => {
    const rules = [rule('r1', 'a', 'b'), rule('r2', 'a', 'c')];
    expect(applicableRules(rules, new Set(['a', 'b'])).map((r) => r.id)).toEqual(['r1']);
  });
});
