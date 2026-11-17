import { TestBed } from '@angular/core/testing';
import type { Route } from '@angular/router';
import { routes } from './app.routes';

/** The browser tab, history and a screen reader's page announcement all read the route title. */
describe('public sign-up route titles', () => {
  const PAGES = ['signup', 'privacy', 'line-share/signup', 'line-share/link'];
  const titleOf = (path: string): string => {
    const route = routes.find((r) => r.path === path) as Route;
    expect(route, path).toBeDefined();
    expect(typeof route.title, `${path} has a title function`).toBe('function');
    return TestBed.runInInjectionContext(() => (route.title as () => string)());
  };

  it.each(PAGES)('%s has its own title that still names the product', (path) => {
    const title = titleOf(path);
    expect(title).toContain('JubBad');
    expect(title.trim().length).toBeGreaterThan('JubBad'.length + 3);
  });

  it('gives each page a different title', () => {
    const titles = PAGES.map(titleOf);
    expect(new Set(titles).size).toBe(PAGES.length);
  });
});
