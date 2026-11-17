import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SignupService } from '../../core/signup.service';
import { SceneHost } from '../../core/three/scene-host';
import { Icon } from '../../shared/icon/icon';
import { PasswordField } from '../../shared/password-field/password-field';

type Problem = 'taken' | 'short' | 'rate' | 'invalid' | 'error';

const MIN_PASSWORD = 8;

/**
 * Website sign-up: email and password, a free account. LINE is optional here; linking it later starts the
 * 30-day trial. When the server offers LINE sign-up the page links to it as a second way in.
 */
@Component({
  selector: 'app-signup',
  imports: [FormsModule, RouterLink, PasswordField, SceneHost, Icon],
  templateUrl: './signup.html',
  styleUrl: './signup.css',
})
export class Signup implements OnInit {
  private readonly api = inject(SignupService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly emailEl = viewChild<ElementRef<HTMLInputElement>>('emailField');
  private readonly passwordEl = viewChild(PasswordField);

  protected readonly minPassword = MIN_PASSWORD;
  protected readonly passwordHint = $localize`:@@signup.passwordHint:อย่างน้อย 8 ตัวอักษร`;
  protected readonly email = signal('');
  protected readonly password = signal('');
  /** The hidden bot trap: no person ever types here. */
  protected readonly trap = signal('');
  protected readonly busy = signal(false);
  protected readonly problem = signal<Problem | null>(null);
  protected readonly lineSignupUrl = signal<string | null>(null);
  /** Typed, but not long enough yet: the hint says so at once instead of after a failed submit. */
  protected readonly passwordTooShort = computed(() => this.password().length > 0 && this.password().length < MIN_PASSWORD);
  protected readonly canSubmit = computed(
    () => !this.busy() && this.email().trim() !== '' && this.password().length >= MIN_PASSWORD,
  );

  async ngOnInit(): Promise<void> {
    try {
      this.lineSignupUrl.set((await this.api.info()).lineSignupUrl);
    } catch {
      // The LINE option is a nicety; the form works without it.
      this.lineSignupUrl.set(null);
    }
  }

  protected onEmail(value: string): void {
    this.email.set(value);
    this.problem.set(null);
  }

  protected onPassword(value: string): void {
    this.password.set(value);
    this.problem.set(null);
  }

  protected async onSubmit(): Promise<void> {
    if (this.busy() || !this.email().trim() || !this.password()) return;
    if (this.password().length < MIN_PASSWORD) {
      this.problem.set('short');
      this.passwordEl()?.focus();
      return;
    }
    this.busy.set(true);
    this.problem.set(null);
    const result = await this.api.register(this.email().trim(), this.password(), this.trap());
    this.busy.set(false);
    if (result === 'ok') {
      await this.auth.check();
      await this.router.navigate(['/groups/new'], { replaceUrl: true });
      return;
    }
    // The typed values stay: a wrong guess is fixed, not retyped. Focus goes to what needs changing.
    this.problem.set(result === 'email-taken' ? 'taken' : result);
    if (result === 'invalid' || result === 'email-taken') this.emailEl()?.nativeElement.focus();
  }
}
