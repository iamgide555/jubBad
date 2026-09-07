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

  readonly token = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async submit(): Promise<void> {
    if (!this.token().trim() || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    const result = await this.auth.login(this.token().trim());
    this.busy.set(false);

    if (result === true) {
      // Back to whatever they were reaching for before the guard stopped them.
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
      this.router.navigateByUrl(returnUrl);
      return;
    }

    // A throttled attempt gets its own message: repeating "wrong token" at
    // someone whose token is right just makes them try harder and stay locked.
    this.error.set(
      result === 'throttled'
        ? $localize`:@@login.throttled:ลองมากเกินไป รอสักครู่แล้วลองใหม่`
        : $localize`:@@login.wrongToken:โทเคนไม่ถูกต้อง`
    );
    this.token.set('');
  }
}
