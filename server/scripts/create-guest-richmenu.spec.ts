import { describe, expect, it } from 'vitest';
import { guestMenuDefinition } from './create-guest-richmenu.mjs';

describe('guestMenuDefinition', () => {
  it('describes two side-by-side link areas that cover the whole image', () => {
    const menu = guestMenuDefinition('L1');
    expect(menu.size).toEqual({ width: 2500, height: 843 });
    expect(menu.areas.map((a: { bounds: unknown }) => a.bounds)).toEqual([
      { x: 0, y: 0, width: 1250, height: 843 },
      { x: 1250, y: 0, width: 1250, height: 843 },
    ]);
    expect(menu.areas.map((a: { action: unknown }) => a.action)).toEqual([
      { type: 'uri', uri: 'https://liff.line.me/L1/signup' },
      { type: 'uri', uri: 'https://liff.line.me/L1/link' },
    ]);
  });

  it('is shown at once and named for the guests it is for', () => {
    const menu = guestMenuDefinition('L1');
    expect(menu).toMatchObject({ selected: true, name: 'jubbad-guest', chatBarText: 'เมนู' });
  });
});
