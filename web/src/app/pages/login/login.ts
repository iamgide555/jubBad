import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

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

  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  readonly showForgot = signal(false);
  readonly forgotEmail = signal('');
  readonly forgotSent = signal(false);
  readonly forgotBusy = signal(false);

  async submit(): Promise<void> {
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

  openForgot(): void {
    this.showForgot.set(true);
    this.forgotSent.set(false);
    this.forgotEmail.set(this.email());
  }

  /**
   * There is no automated delivery (see docs/2026-09-12-b12-per-user-login.md
   * — Forgot password): this only ever reaches the admin console as a
   * pending request. The confirmation says so, and is worded not to reveal
   * whether the address has an account, matching what the server itself
   * refuses to reveal.
   */
  async submitForgot(): Promise<void> {
    if (!this.forgotEmail().trim() || this.forgotBusy()) return;

    this.forgotBusy.set(true);
    await this.auth.forgotPassword(this.forgotEmail().trim());
    this.forgotBusy.set(false);
    this.forgotSent.set(true);
  }
}
