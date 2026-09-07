/**
 * Turns an in-app router path into a link someone can paste into LINE.
 *
 * Resolved against `document.baseURI` rather than `location.origin`, because
 * Angular serves Thai at `/` and English under `/en/`. Using the origin alone
 * would send every English host's links to the Thai app.
 */
export function absoluteUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), document.baseURI).href;
}

/**
 * Returns whether the copy actually happened rather than throwing.
 *
 * The clipboard API is unavailable on an insecure origin and in older
 * browsers, and can be denied outright. A share button whose failure mode is an
 * unhandled rejection is worse than one that can say it did not work — the
 * caller shows the link instead so it can still be copied by hand.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
