import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SceneHost } from '../../core/three/scene-host';
import { Login } from './login';

@Component({ selector: 'app-scene-host', template: '' })
class SceneHostStub {}

describe('Login', () => {
  let fixture: ComponentFixture<Login>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { login: vi.fn(), forgotPassword: vi.fn() } }],
    });
    // The 3D hero needs a canvas; the sign-in form is what is under test.
    TestBed.overrideComponent(Login, { remove: { imports: [SceneHost] }, add: { imports: [SceneHostStub] } });
    fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
  });

  it('links people without an account to the sign-up page', () => {
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('[data-signup-link]');
    expect(link?.getAttribute('href')).toBe('/signup');
  });

  it('tells someone who forgot their password that linked LINE accounts can reset it in the bot chat', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-line-recovery]')).toBeNull();
    root.querySelector<HTMLButtonElement>('button.link')!.click();
    fixture.detectChanges();
    const note = root.querySelector('[data-line-recovery]');
    expect(note?.textContent).toContain('LINE');
    expect(note?.textContent).toContain('ลืมรหัสผ่าน');
  });
});

