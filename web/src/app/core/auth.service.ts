import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type LoginResult = boolean | 'throttled';

/**
 * The credential is an httpOnly cookie the browser holds and attaches by
 * itself, so this service never sees or stores a token. `isAuthed` is only a
 * hint for rendering — the server decides on every request, and the route guard
 * confirms with `check()` rather than trusting the flag.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  private readonly authed = signal(false);
  readonly isAuthed = this.authed.asReadonly();

  async login(token: string): Promise<LoginResult> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/auth/login`, { token }));
      this.authed.set(true);
      return true;
    } catch (error) {
      this.authed.set(false);
      // Told apart so the form can say "wait a moment" rather than repeating
      // "wrong token" at someone whose token is right.
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
      this.authed.set(false);
    }
  }

  /** Asks the server, which is the only thing that actually knows. */
  async check(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ authenticated: boolean }>(`${this.base}/auth/me`)
      );
      this.authed.set(res.authenticated);
      return res.authenticated;
    } catch {
      this.authed.set(false);
      return false;
    }
  }
}
