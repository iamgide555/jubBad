import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

export interface GroupSummary {
  code: string;
  name: string | null;
  sessionCount: number;
  playerCount: number;
  lastSessionCode: string | null;
  lastSessionAt: string | null;
}

/**
 * The admin's home. Until now this page could only mint a new group, so a group
 * was reachable solely by its bookmarked URL — lose the bookmark and the group
 * was gone, since nothing in the API could enumerate them.
 */
@Component({
  selector: 'app-landing',
  imports: [FormsModule, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class Landing {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiBaseUrl;

  readonly groups = signal<GroupSummary[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);

  readonly removingCode = signal<string | null>(null);
  readonly removeConfirmText = signal('');
  readonly removeError = signal<string | null>(null);

  // Populated as a side effect of adminGuard's auth.check() before this page
  // ever renders (see app.routes.ts), so this is never stale on first paint.
  readonly isAdmin = computed(() => this.auth.role() === 'admin');

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.groups.set(await firstValueFrom(this.http.get<GroupSummary[]>(`${this.base}/groups`)));
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  retryLoad(): void {
    this.loaded.set(false);
    void this.load();
  }

  startNewGroup(): void {
    const groupCode = crypto.randomUUID().slice(0, 8);
    this.router.navigateByUrl(`/g/${groupCode}`);
  }

  startRemove(group: GroupSummary): void {
    this.removingCode.set(group.code);
    this.removeConfirmText.set('');
    this.removeError.set(null);
  }

  cancelRemove(): void {
    this.removingCode.set(null);
    this.removeConfirmText.set('');
  }

  /**
   * Same rule as the group's own danger zone: type the name. Deleting a group
   * takes every session, player and match with it and there is no undo, so the
   * guard is deliberately something you cannot do by reflex — and it is the
   * same gesture in both places rather than two different confirmations for one
   * irreversible act.
   */
  readonly canRemove = computed(() => {
    const group = this.groups().find((g) => g.code === this.removingCode());
    const expected = group?.name?.trim() ?? '';
    return expected.length > 0 && this.removeConfirmText().trim() === expected;
  });

  async confirmRemove(): Promise<void> {
    const code = this.removingCode();
    if (!code || !this.canRemove()) return;

    try {
      await firstValueFrom(this.http.delete(`${this.base}/groups/${code}`));
      this.groups.update((groups) => groups.filter((g) => g.code !== code));
      this.cancelRemove();
    } catch {
      this.removeError.set($localize`:@@home.removeFailed:ลบก๊วนไม่สำเร็จ`);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
