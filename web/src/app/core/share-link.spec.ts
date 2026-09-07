import { absoluteUrl, copyToClipboard } from './share-link';

describe('absoluteUrl', () => {
  it('builds a full URL a phone can open from a bare path', () => {
    // A shared link has to survive leaving the app, so a router path is not
    // enough — it has to carry the origin.
    expect(absoluteUrl('/g/abc/p/xyz')).toBe(`${location.origin}/g/abc/p/xyz`);
  });

  it('accepts a path with or without its leading slash', () => {
    expect(absoluteUrl('g/abc')).toBe(absoluteUrl('/g/abc'));
  });

  it('keeps the locale the sharer is using', () => {
    // Angular serves Thai at / and English under /en/, so resolving against
    // baseURI rather than origin means an English host shares an English link
    // and a Thai host shares a Thai one.
    const base = document.createElement('base');
    base.href = `${location.origin}/en/`;
    document.head.appendChild(base);
    try {
      expect(absoluteUrl('/s/abc/display')).toBe(`${location.origin}/en/s/abc/display`);
    } finally {
      base.remove();
    }
  });
});

describe('copyToClipboard', () => {
  const original = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });

  function stubClipboard(impl: () => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: impl },
      configurable: true,
    });
  }

  it('reports success when the text is copied', async () => {
    let written = '';
    stubClipboard(async () => {
      written = 'called';
    });
    expect(await copyToClipboard('hello')).toBe(true);
    expect(written).toBe('called');
  });

  it('reports failure rather than throwing when the browser refuses', async () => {
    // Clipboard access is denied on insecure origins and in older browsers.
    // A share button that throws is worse than one that says it could not.
    stubClipboard(() => Promise.reject(new Error('denied')));
    expect(await copyToClipboard('hello')).toBe(false);
  });

  it('reports failure when there is no clipboard API at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(await copyToClipboard('hello')).toBe(false);
  });
});
