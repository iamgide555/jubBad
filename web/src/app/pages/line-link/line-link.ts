import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LineViewer } from '../../core/line-viewer';
import { bangkokDisplayDate } from '../../core/plan';
import { SignupService, type LineLinkResult } from '../../core/signup.service';
import { PasswordField } from '../../shared/password-field/password-field';
import { StatusBlock } from '../../shared/status-block/status-block';

type Phase = 'loading' | 'login' | 'unavailable' | 'lineDown' | 'error' | 'linked' | 'form' | 'done';
type Problem = 'badCredentials' | 'accountLinked' | 'lineLinked' | 'rate' | 'error';

/**
 * Links this LINE account to a JubBad account that already exists, proven by that account's email and password. It
 * opens through LIFF inside LINE's own browser, where the host is not signed in to JubBad, which is why it asks for
 * the credentials instead of using a session; and why it signs no one in. The first link starts the 30-day trial.
 */
@Component({
  selector: 'app-line-link',
  imports: [FormsModule, RouterLink, PasswordField, StatusBlock],
  templateUrl: './line-link.html',
  styleUrl: './line-link.css',
})
export class LineLink {
  private readonly api = inject(SignupService);
  private readonly viewer = inject(LineViewer);
  private readonly emailEl = viewChild<ElementRef<HTMLInputElement>>('emailField');
  private readonly passwordEl = viewChild(PasswordField);
  private accessToken = '';
  private loading = false;
  private botAddUrl: string | null = null;

  protected readonly phase = signal<Phase>('loading');
  protected readonly lineName = signal<string | null>(null);
  protected readonly trialAvailable = signal(true);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly problem = signal<Problem | null>(null);
  protected readonly trialEnd = signal<string | null>(null);
  /** The bot's add-friend link, only when the LINE account is known not to be a friend yet. */
  protected readonly addBotUrl = signal<string | null>(null);

  constructor() {
    void this.load();
  }

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
    const status = await this.api.lineStatus(this.accessToken);
    if (status === 'unavailable') return this.phase.set('lineDown');
    if (status === 'unauthorized') return this.loginAgain();
    if (status === 'error') return this.phase.set('error');
    this.lineName.set(status.lineDisplayName);
    this.trialAvailable.set(status.trialAvailable);
    this.phase.set(status.registered ? 'linked' : 'form');
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
    this.busy.set(true);
    this.problem.set(null);
    const result = await this.api.lineLink(this.accessToken, this.email().trim(), this.password());
    this.busy.set(false);
    await this.finish(result);
  }

  private async finish(result: LineLinkResult): Promise<void> {
    if (typeof result === 'object') {
      this.trialEnd.set(result.trialUntil ? bangkokDisplayDate(result.trialUntil) : null);
      this.addBotUrl.set(result.botFriend === false ? this.botAddUrl : null);
      this.phase.set('done');
      return;
    }
    if (result === 'unauthorized') return this.loginAgain();
    if (result === 'unavailable') return this.problem.set('error');
    this.problem.set(
      result === 'bad-credentials'
        ? 'badCredentials'
        : result === 'account-linked'
          ? 'accountLinked'
          : result === 'line-linked'
            ? 'lineLinked'
            : result,
    );
    // A wrong password is retyped (and cleared, as sign-in does); anything else keeps what was typed.
    if (result === 'bad-credentials') {
      this.password.set('');
      this.passwordEl()?.focus();
    } else if (result === 'account-linked') {
      this.emailEl()?.nativeElement.focus();
    }
  }
}
