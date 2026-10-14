import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PressDirective } from './press.directive';

@Component({
  imports: [PressDirective],
  template: `<button type="button" appPress>tap</button>`,
})
class Host {}

describe('PressDirective', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  let button: HTMLButtonElement;

  let play: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // `play` is the directive's only call into the animation library.
    play = vi.spyOn(PressDirective.prototype as unknown as { play: () => void }, 'play').mockImplementation(() => {}) as never;
    // Pin the OS setting: another spec's matchMedia stub must not decide whether presses animate.
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({ matches: false }),
      configurable: true,
      writable: true,
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    button = fixture.nativeElement.querySelector('button');
  });

  const fire = (type: string) => button.dispatchEvent(new Event(type));

  it('marks the host so the CSS :active scale can step aside', () => {
    expect(button.hasAttribute('data-press')).toBe(true);
  });

  it('does not animate when the pointer merely passes over', () => {
    fire('pointerleave');
    expect(play).not.toHaveBeenCalled();
  });

  it('bounces once on a tap, not again on the pointerleave that follows', () => {
    fire('pointerdown');
    fire('pointerup');
    fire('pointerleave');
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][0]).toEqual([0.94, 1.03, 1]);
  });

  it('settles back without overshoot when the pointer slides off mid-press', () => {
    fire('pointerdown');
    fire('pointerleave');
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][0]).toBe(1);
  });
});
