import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

/**
 * Reached from a one-time link an admin sends by hand (LINE, usually) — see
 * AuthController#resetPassword. There is no cookie here at all, which is why
 * this route is unguarded (app.routes.ts) and this page is the only one a
 * signed-out visitor can use to change anything.
 */
@Component({
  selector: 'app-reset-password',
  imports: [FormsModule],
  templateUrl: './reset-password.html',
  styleUrl: './reset-password.css',
})
export class ResetPassword {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly token: string;

  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly done = signal(false);

  constructor(route: ActivatedRoute) {
    this.token = route.snapshot.paramMap.get('token') ?? '';
  }

  readonly canSubmit = () =>
    this.password().length >= 8 && this.password() === this.confirmPassword() && !this.busy();

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;

    if (this.password() !== this.confirmPassword()) {
      this.error.set($localize`:@@resetPassword.mismatch:รหัสผ่านทั้งสองช่องไม่ตรงกัน`);
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    const ok = await this.auth.resetPassword(this.token, this.password());
    this.busy.set(false);

    if (ok) {
      this.done.set(true);
      return;
    }

    this.error.set(
      $localize`:@@resetPassword.failed:ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว ขอลิงก์ใหม่จากผู้ดูแล`
    );
  }

  goToLogin(): void {
    this.router.navigateByUrl('/login');
  }
}
