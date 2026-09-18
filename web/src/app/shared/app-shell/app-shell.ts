import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { PressDirective } from '../../core/motion/press.directive';
import { ThemeService } from '../../core/theme/theme.service';
import { Icon } from '../icon/icon';

/**
 * The one piece of chrome every route sits inside — a thin top bar carrying
 * the feather mark and the theme toggle. It renders on all ten routes,
 * including the two unguarded public ones (session display, session
 * summary): a stranger opening a shared link should still land in a shell
 * that reads as a real product, not a bare component.
 *
 * The venue display route (session-display) hides this bar via `:host-context`
 * — see app-shell.css — since that screen is deliberately furniture with
 * nothing on it to tap.
 */
@Component({
  selector: 'app-shell',
  imports: [Icon, PressDirective],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.css',
})
export class AppShell {
  protected readonly theme = inject(ThemeService);

  private readonly router = inject(Router);
  /** The venue wall display is deliberately bare furniture — see the class
   *  doc — so the shell renders nothing at all on that one route rather than
   *  a bar nobody standing across the hall would ever reach to tap. */
  protected readonly isDisplayRoute = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.includes('/display')),
      startWith(this.router.url.includes('/display'))
    ),
    { initialValue: this.router.url.includes('/display') }
  );

  protected themeIcon(): 'sun' | 'moon' | 'system' {
    if (this.theme.preference() === 'system') return 'system';
    return this.theme.resolved() === 'dark' ? 'moon' : 'sun';
  }
}
