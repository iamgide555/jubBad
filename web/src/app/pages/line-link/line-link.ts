import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LineViewer } from '../../core/line-viewer';
import { bangkokDisplayDate } from '../../core/plan';
import { SignupService, type LineLinkResult } from '../../core/signup.service';

type Phase = 'loading' | 'login' | 'unavailable' | 'lineDown' | 'error' | 'linked' | 'form' | 'done';
type Problem = 'badCredentials' | 'accountLinked' | 'lineLinked' | 'rate' | 'error';

/**
 * Links this LINE account to a JubBad account that already exists, proven by that account's email and password. It
 * opens through LIFF inside LINE's own browser, where the host is not signed in to JubBad, which is why it asks for
 * the credentials instead of using a session; and why it signs no one in. The first link starts the 30-day trial.
 */
@Component({
  selector: 'app-line-link',
  imports: [FormsModule, RouterLink],
  templateUrl: './line-link.html',
  styleUrl: './line-link.css',
})
export class LineLink {
  private readonly api = inject(SignupService);
  private readonly viewer = inject(LineViewer);
  private accessToken = '';
  private loading = false;

  protected readonly phase = signal<Phase>('loading');
  protected readonly lineName = signal<string | null>(null);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly problem = signal<Problem | null>(null);
  protected readonly trialEnd = signal<string | null>(null);

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
    const status = await this.api.lineStatus(this.accessToken);
    if (status === 'unavailable') return this.phase.set('lineDown');
    if (status === 'unauthorized' || status === 'error') return this.phase.set('error');
    this.lineName.set(status.lineDisplayName);
    this.phase.set(status.registered ? 'linked' : 'form');
  }

  protected async onSubmit(): Promise<void> {
    if (this.busy() || !this.email().trim() || !this.password()) return;
    this.busy.set(true);
    this.problem.set(null);
    const result = await this.api.lineLink(this.accessToken, this.email().trim(), this.password());
    this.busy.set(false);
    this.finish(result);
  }

  private finish(result: LineLinkResult): void {
    if (typeof result === 'object') {
      this.trialEnd.set(result.trialUntil ? bangkokDisplayDate(result.trialUntil) : null);
      this.phase.set('done');
      return;
    }
    this.password.set('');
    if (result === 'unauthorized') return this.phase.set('error');
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
  }
}
