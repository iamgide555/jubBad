import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LineViewer } from '../../core/line-viewer';
import { bangkokDisplayDate } from '../../core/plan';
import { SignupService, type LineSignupResult } from '../../core/signup.service';
import { PasswordField } from '../../shared/password-field/password-field';
import { StatusBlock } from '../../shared/status-block/status-block';

type Phase = 'loading' | 'login' | 'unavailable' | 'lineDown' | 'error' | 'signedIn' | 'registered' | 'form' | 'done';
type Problem = 'taken' | 'short' | 'rate' | 'invalid' | 'error';

const MIN_PASSWORD = 8;

/**
 * The sign-up page behind the bot's menu button and the website's "สมัครด้วย LINE" link, opened through LIFF. LINE says
 * who the viewer is (the server checks the access token with LINE), and the account that comes out is created already
 * linked, so the 30-day trial starts at once unless this LINE account has had one.
 */
@Component({
  selector: 'app-line-signup',
  imports: [FormsModule, RouterLink, PasswordField, StatusBlock],
  templateUrl: './line-signup.html',
  styleUrl: './line-signup.css',
})
export class LineSignup {
  private readonly api = inject(SignupService);
  private readonly viewer = inject(LineViewer);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly emailEl = viewChild<ElementRef<HTMLInputElement>>('emailField');
  private readonly passwordEl = viewChild(PasswordField);
  private accessToken = '';
  private loading = false;
  private botAddUrl: string | null = null;

  protected readonly minPassword = MIN_PASSWORD;
  protected readonly passwordHint = $localize`:@@signup.passwordHint:อย่างน้อย 8 ตัวอักษร`;
  protected readonly phase = signal<Phase>('loading');
  protected readonly lineName = signal<string | null>(null);
  protected readonly trialAvailable = signal(true);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly passwordTooShort = computed(() => this.password().length > 0 && this.password().length < MIN_PASSWORD);
  protected readonly canSubmit = computed(
    () => !this.busy() && this.email().trim() !== '' && this.password().length >= MIN_PASSWORD,
  );
  protected readonly problem = signal<Problem | null>(null);
  /** The account this browser is already signed in to, when it is. */
  protected readonly signedInEmail = signal<string | null>(null);
  /** When the trial ends, as dd/mm/yyyy; null when this sign-up got none. */
  protected readonly trialEnd = signal<string | null>(null);
  /** The bot's add-friend link, only when the LINE account is known not to be a friend yet. */
  protected readonly addBotUrl = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  /** Also the retry after LINE did not answer. */
  protected async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.phase.set('loading');
    try {
      await this.start();
    } finally {
      this.loading = false;
    }
  }

  private async start(): Promise<void> {
    const started = await this.viewer.start();
    if (started.kind === 'redirecting') return this.phase.set('login');
    if (started.kind === 'unavailable') return this.phase.set('unavailable');
    if (started.kind === 'error') return this.phase.set('error');
    this.accessToken = started.accessToken;
    this.botAddUrl = started.botAddUrl;
    // A host already signed in here should not make a second account by tapping the sign-up button: the server would
    // swap their session for the new one.
    if (await this.auth.check()) {
      this.signedInEmail.set(this.auth.email());
      return this.phase.set('signedIn');
    }
    const status = await this.api.lineStatus(this.accessToken);
    if (status === 'unavailable') return this.phase.set('lineDown');
    if (status === 'unauthorized') return this.loginAgain();
    if (status === 'error') return this.phase.set('error');
    this.lineName.set(status.lineDisplayName);
    this.trialAvailable.set(status.trialAvailable);
    this.phase.set(status.registered ? 'registered' : 'form');
  }

  /** LINE refused the access token (expired or revoked): log in again for a fresh one instead of retrying the same. */
  private async loginAgain(): Promise<void> {
    const restarted = await this.viewer.restart();
    this.phase.set(restarted.kind === 'redirecting' ? 'login' : 'error');
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
    const result = await this.api.lineSignup(this.accessToken, this.email().trim(), this.password());
    this.busy.set(false);
    await this.finish(result);
  }

  private async finish(result: LineSignupResult): Promise<void> {
    if (typeof result === 'object') {
      this.trialEnd.set(result.trialUntil ? bangkokDisplayDate(result.trialUntil) : null);
      this.addBotUrl.set(result.botFriend === false ? this.botAddUrl : null);
      this.phase.set('done');
      return;
    }
    if (result === 'line-registered') return this.phase.set('registered');
    if (result === 'unauthorized') return this.loginAgain();
    // The typed values stay; focus goes to what needs changing.
    this.problem.set(result === 'email-taken' ? 'taken' : result === 'unavailable' ? 'error' : result);
    if (result === 'email-taken' || result === 'invalid') this.emailEl()?.nativeElement.focus();
  }

  protected async continue(): Promise<void> {
    await this.auth.check();
    await this.router.navigate(['/groups/new'], { replaceUrl: true });
  }
}
