import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LineAvatar } from './line-avatar';

@Component({
  imports: [LineAvatar],
  template: `<app-line-avatar [name]="name" [pictureUrl]="pictureUrl" [size]="32" />`,
})
class Host {
  name: string | null = 'Tam';
  pictureUrl: string | null = 'https://profile.example/tam.jpg';
}

describe('LineAvatar', () => {
  function mount(patch: Partial<Host> = {}) {
    const fixture = TestBed.createComponent(Host);
    Object.assign(fixture.componentInstance, patch);
    fixture.detectChanges();
    return fixture;
  }
  const el = (f: ReturnType<typeof mount>) => f.nativeElement as HTMLElement;

  it('shows the picture without sending a referrer', () => {
    const img = el(mount()).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://profile.example/tam.jpg');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('falls back to the initial when the picture fails to load', () => {
    const fixture = mount();
    el(fixture).querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(el(fixture).querySelector('img')).toBeNull();
    expect(el(fixture).querySelector('.initial')!.textContent!.trim()).toBe('T');
  });

  it('shows the initial when there is no picture, and a placeholder mark when there is no name either', () => {
    expect(el(mount({ pictureUrl: null })).querySelector('.initial')!.textContent!.trim()).toBe('T');
    expect(el(mount({ pictureUrl: null, name: null })).querySelector('.initial')!.textContent!.trim()).toBe('?');
  });
});
