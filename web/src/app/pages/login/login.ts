import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

type Mode = 'login' | 'forgot';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * One form, two modes — not a second form appended below the first. Forgot
   * mode is the same email field with the password field hidden, not a
   * separate flow bolted on underneath.
   */
  readonly mode = signal<Mode>('login');

  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  readonly forgotSent = signal(false);
  readonly forgotExists = signal(false);

  switchToForgot(): void {
    this.mode.set('forgot');
    this.error.set(null);
    this.forgotSent.set(false);
  }

  switchToLogin(): void {
    this.mode.set('login');
    this.error.set(null);
    this.password.set('');
  }

  async onSubmit(): Promise<void> {
    if (this.mode() === 'forgot') {
      await this.submitForgot();
    } else {
      await this.submitLogin();
    }
  }

  private async submitLogin(): Promise<void> {
    if (!this.email().trim() || !this.password() || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    const result = await this.auth.login(this.email().trim(), this.password());
    this.busy.set(false);

    if (result === true) {
      // Back to whatever they were reaching for before the guard stopped them.
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
      this.router.navigateByUrl(returnUrl);
      return;
    }

    // A throttled attempt gets its own message: repeating "wrong password" at
    // someone whose password is right just makes them try harder and stay
    // locked. A wrong password and an unknown email get the same message —
    // telling them apart would let this form be used to find out which
    // emails have accounts.
    this.error.set(
      result === 'throttled'
        ? $localize`:@@login.throttled:ลองมากเกินไป รอสักครู่แล้วลองใหม่`
        : $localize`:@@login.wrongCredentials:อีเมลหรือรหัสผ่านไม่ถูกต้อง`
    );
    this.password.set('');
  }

  /**
   * There is no automated delivery (see docs/archive/plans/2026-09-12-b12-per-user-login.md
   * — Forgot password): a matched request only ever reaches the admin
   * console as a pending item, never an email. This app tells the caller
   * plainly whether the address has an account (a deliberate reversal from
   * the safer anti-enumeration default — see AuthController#forgotPassword),
   * so the two outcomes get different confirmations.
   */
  private async submitForgot(): Promise<void> {
    if (!this.email().trim() || this.busy()) return;

    this.busy.set(true);
    const exists = await this.auth.forgotPassword(this.email().trim());
    this.busy.set(false);
    this.forgotExists.set(exists);
    this.forgotSent.set(true);
  }
}
