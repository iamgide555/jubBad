import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type LoginResult = boolean | 'throttled';
export type Role = 'admin' | 'host';

interface MeResponse {
  authenticated: boolean;
  role?: Role;
  email?: string;
}

/**
 * The credential is an httpOnly cookie the browser holds and attaches by
 * itself, so this service never sees or stores a password. `isAuthed` is only
 * a hint for rendering — the server decides on every request, and the route
 * guard confirms with `check()` rather than trusting the flag.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  private readonly authed = signal(false);
  readonly isAuthed = this.authed.asReadonly();

  private readonly currentRole = signal<Role | null>(null);
  readonly role = this.currentRole.asReadonly();

  private readonly currentEmail = signal<string | null>(null);
  readonly email = this.currentEmail.asReadonly();

  async login(email: string, password: string): Promise<LoginResult> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/auth/login`, { email, password }));
      // The login response only confirms success; it does not carry role or
      // email, so ask /auth/me for those rather than guessing them here.
      await this.check();
      return true;
    } catch (error) {
      this.setUnauthenticated();
      // Told apart so the form can say "wait a moment" rather than repeating
      // "wrong credentials" at someone whose credentials are right.
      if (error instanceof HttpErrorResponse && error.status === 429) return 'throttled';
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/auth/logout`, {}));
    } finally {
      // Locally signed out even if the request failed: leaving the UI in a
      // signed-in state after someone asked to leave is the worse failure.
      this.setUnauthenticated();
    }
  }

  /**
   * Returns whether `email` actually matches an account — the server reports
   * this plainly rather than hiding it (a deliberate reversal for this app;
   * see AuthController#forgotPassword). A network failure reads as "no
   * account", the safer of the two wrong answers to give on an error.
   */
  async forgotPassword(email: string): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ received: true; exists: boolean }>(`${this.base}/auth/forgot`, { email })
      );
      return res.exists;
    } catch {
      return false;
    }
  }

  /**
   * Sets a new password from a one-time reset link. False covers every
   * failure the same way: expired, already used, or simply wrong — a locked-
   * out host gets one message either way, not a hint about which.
   */
  async resetPassword(token: string, password: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/auth/reset/${token}`, { password }));
      return true;
    } catch {
      return false;
    }
  }

  /** Asks the server, which is the only thing that actually knows. */
  async check(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.get<MeResponse>(`${this.base}/auth/me`)
      );
      this.authed.set(res.authenticated);
      this.currentRole.set(res.role ?? null);
      this.currentEmail.set(res.email ?? null);
      return res.authenticated;
    } catch {
      this.setUnauthenticated();
      return false;
    }
  }

  private setUnauthenticated(): void {
    this.authed.set(false);
    this.currentRole.set(null);
    this.currentEmail.set(null);
  }
}
