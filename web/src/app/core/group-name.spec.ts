import { findOwnDuplicate, sameGroupName } from './group-name';

describe('sameGroupName', () => {
  it('ignores surrounding and repeated whitespace and Latin case', () => {
    expect(sameGroupName('  ก๊วน  อังคาร ', 'ก๊วน อังคาร')).toBe(true);
    expect(sameGroupName('Badminton Club', 'badminton club')).toBe(true);
  });

  it('treats different names as different', () => {
    expect(sameGroupName('ก๊วนอังคาร', 'ก๊วนพุธ')).toBe(false);
  });
});

describe('findOwnDuplicate', () => {
  const groups = [
    { code: 'a', name: 'ก๊วนอังคาร' },
    { code: 'b', name: null },
    { code: 'c', name: 'ของคนอื่น', mine: false },
  ];

  it('finds the caller\'s own group with the same name', () => {
    expect(findOwnDuplicate(groups, ' ก๊วนอังคาร ')).toEqual({ code: 'a', name: 'ก๊วนอังคาร' });
  });

  it('ignores another host\'s group, even with the same name (admin list rows)', () => {
    expect(findOwnDuplicate(groups, 'ของคนอื่น')).toBeNull();
  });

  it('skips the group being renamed', () => {
    expect(findOwnDuplicate(groups, 'ก๊วนอังคาร', 'a')).toBeNull();
  });
});
