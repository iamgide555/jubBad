import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface SignupInfo {
  liffId: string | null;
  /** The LIFF link to the LINE sign-up page; null when LINE sign-up is not set up. */
  lineSignupUrl: string | null;
  /** The bot's add-friend link, when configured. */
  botAddUrl: string | null;
}

export interface LineStatus {
  lineDisplayName: string | null;
  /** This LINE account already belongs to a JubBad account. */
  registered: boolean;
  /** This LINE account has never had the 30-day trial. */
  trialAvailable: boolean;
}

export type RegisterResult = 'ok' | 'email-taken' | 'rate' | 'invalid' | 'error';
export type LineStatusResult = LineStatus | 'unauthorized' | 'unavailable' | 'error';
export type LineSignupResult =
  | { trialUntil: string | null; botFriend: boolean | null }
  | 'line-registered'
  | 'email-taken'
  | 'rate'
  | 'unauthorized'
  | 'unavailable'
  | 'invalid'
  | 'error';
export type LineLinkResult =
  | { trialUntil: string | null }
  | 'bad-credentials'
  | 'account-linked'
  | 'line-linked'
  | 'rate'
  | 'unauthorized'
  | 'unavailable'
  | 'error';

/** The `code` the server puts in a 4xx body, when it has one. */
function codeOf(error: HttpErrorResponse): string | undefined {
  const body: unknown = error.error;
  return typeof body === 'object' && body !== null && 'code' in body ? String((body as { code: unknown }).code) : undefined;
}

/**
 * The public sign-up routes. The LINE ones identify the viewer by their LIFF access token, sent in a header
 * (never in a body or URL) and checked by the server with LINE. Neither token nor password is stored or logged here.
 */
@Injectable({ providedIn: 'root' })
export class SignupService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/auth`;

  private headers(accessToken: string): HttpHeaders {
    return new HttpHeaders({ 'X-Line-Access-Token': accessToken });
  }

  info(): Promise<SignupInfo> {
    return firstValueFrom(this.http.get<SignupInfo>(`${this.base}/signup-info`));
  }

  /** `website` is the hidden bot trap: a person never fills it. */
  async register(email: string, password: string, website: string): Promise<RegisterResult> {
    try {
      await firstValueFrom(this.http.post(`${this.base}/register`, { email, password, website }));
      return 'ok';
    } catch (e) {
      if (!(e instanceof HttpErrorResponse)) return 'error';
      if (e.status === 409 && codeOf(e) === 'EMAIL_TAKEN') return 'email-taken';
      if (e.status === 429) return 'rate';
      return e.status === 400 ? 'invalid' : 'error';
    }
  }

  async lineStatus(accessToken: string): Promise<LineStatusResult> {
    try {
      return await firstValueFrom(this.http.post<LineStatus>(`${this.base}/line/status`, {}, { headers: this.headers(accessToken) }));
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 401) return 'unauthorized';
      return e instanceof HttpErrorResponse && e.status === 503 ? 'unavailable' : 'error';
    }
  }

  async lineSignup(accessToken: string, email: string, password: string): Promise<LineSignupResult> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ trialUntil: string | null; botFriend: boolean | null }>(
          `${this.base}/line/signup`,
          { email, password },
          { headers: this.headers(accessToken) },
        ),
      );
      return { trialUntil: res.trialUntil, botFriend: res.botFriend };
    } catch (e) {
      if (!(e instanceof HttpErrorResponse)) return 'error';
      if (e.status === 409) {
        const code = codeOf(e);
        if (code === 'LINE_ALREADY_REGISTERED') return 'line-registered';
        return code === 'EMAIL_TAKEN' ? 'email-taken' : 'error';
      }
      if (e.status === 429) return 'rate';
      if (e.status === 401) return 'unauthorized';
      if (e.status === 503) return 'unavailable';
      return e.status === 400 ? 'invalid' : 'error';
    }
  }

  async lineLink(accessToken: string, email: string, password: string): Promise<LineLinkResult> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ linked: true; trialUntil: string | null }>(
          `${this.base}/line/link`,
          { email, password },
          { headers: this.headers(accessToken) },
        ),
      );
      return { trialUntil: res.trialUntil };
    } catch (e) {
      if (!(e instanceof HttpErrorResponse)) return 'error';
      if (e.status === 401) return codeOf(e) === 'BAD_CREDENTIALS' ? 'bad-credentials' : 'unauthorized';
      if (e.status === 409) {
        const code = codeOf(e);
        if (code === 'ACCOUNT_ALREADY_LINKED') return 'account-linked';
        return code === 'LINE_ALREADY_LINKED' ? 'line-linked' : 'error';
      }
      if (e.status === 429) return 'rate';
      return e.status === 503 ? 'unavailable' : 'error';
    }
  }
}
