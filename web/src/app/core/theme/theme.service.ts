import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'jubbad-theme';
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#faf8f4',
  dark: '#0e1310',
};

/**
 * Owns the light/dark choice for every guarded/host surface. The venue
 * display route never asks this service anything — it is pinned dark in CSS
 * (.page-dark) because it is furniture in a room, not a screen someone
 * holds, and that stays true regardless of what the host's own device
 * prefers.
 *
 * index.html carries a duplicate of the read-and-apply logic below, inline,
 * so the correct theme is on <html> before Angular — or even the first
 * paint — happens. This service takes over from there and is the only thing
 * that writes a *change* after boot.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.(
    '(prefers-color-scheme: dark)'
  );

  private readonly storedPreference = signal<ThemePreference>(this.readStoredPreference());
  readonly preference = this.storedPreference.asReadonly();

  private readonly systemIsDark = signal(this.media?.matches ?? false);

  constructor() {
    this.media?.addEventListener?.('change', (event) => {
      this.systemIsDark.set(event.matches);
      if (this.storedPreference() === 'system') this.applyResolved();
    });
    // Reconciles with whatever index.html's pre-boot script already set,
    // rather than re-deciding independently — the two must never disagree.
    this.applyResolved();
  }

  resolved(): ResolvedTheme {
    const pref = this.storedPreference();
    if (pref === 'system') return this.systemIsDark() ? 'dark' : 'light';
    return pref;
  }

  setPreference(preference: ThemePreference): void {
    this.storedPreference.set(preference);
    try {
      if (preference === 'system') {
        this.document.defaultView?.localStorage.removeItem(STORAGE_KEY);
      } else {
        this.document.defaultView?.localStorage.setItem(STORAGE_KEY, preference);
      }
    } catch {
      // Private browsing / blocked storage: the choice still applies for
      // this load, it just won't survive a refresh.
    }
    this.applyResolved();
  }

  /** Cycles light → dark → system, for a single icon-button toggle. */
  cycle(): void {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(this.storedPreference()) + 1) % order.length];
    this.setPreference(next);
  }

  private applyResolved(): void {
    const theme = this.resolved();
    const root = this.document.documentElement;
    root.setAttribute('data-theme', theme);
    this.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR[theme]);
  }

  private readStoredPreference(): ThemePreference {
    try {
      const stored = this.document.defaultView?.localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      // Falls through to 'system'.
    }
    return 'system';
  }
}
