/**
 * Guards a scroll defect measured on a real session with 53 waiting players.
 *
 * The waiting list is a tray: pinned to the bottom of the screen as a compact
 * one-row bar until the host scrolls to where it lives, then it opens to full
 * size and is meant to "rejoin the page". It kept `position: sticky; bottom: 0`
 * after opening, so a tray taller than the screen stayed frozen on screen while
 * the page scrolled behind it, and the part of it that sat above the pinned
 * edge could never be reached (at 700px wide the first 631px of a 1551px tray).
 *
 * jsdom cannot evaluate this layout, so this reads the real stylesheet as text,
 * the same way styles.contrast.spec.ts does.
 */

// A module, so its top-level names do not collide with styles.contrast.spec.ts.
export {};

// The web test tsconfig has no Node typings, and Angular's builder turns a
// `?raw` import of a .css file into an empty module, so read the stylesheet
// through Node's own loader. `ng test` runs from the web/ workspace root.
const nodeRuntime = (
  globalThis as unknown as {
    process: { cwd(): string; getBuiltinModule(id: string): unknown };
  }
).process;
const nodeFs = nodeRuntime.getBuiltinModule('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const trayCss = nodeFs
  .readFileSync(`${nodeRuntime.cwd()}/src/app/pages/session-dashboard/session-dashboard.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  body: string;
  /** The @media prelude this rule sits in, or null at the top level. */
  media: string | null;
}

/** Every style rule, flattened out of @media blocks, one entry per selector in a list. */
function parseRules(source: string, media: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open === -1) break;
    const prelude = source.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++;
      if (source[j] === '}') depth--;
      j++;
    }
    const body = source.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) {
      rules.push(...parseRules(body, prelude));
    } else if (!prelude.startsWith('@')) {
      for (const selector of prelude.split(',')) {
        rules.push({ selector: selector.trim().replace(/\s+/g, ' '), body, media });
      }
    }
    i = j;
  }
  return rules;
}

const rules = parseRules(trayCss);

function rulesFor(selector: string): Rule[] {
  return rules.filter((r) => r.selector === selector);
}

function declared(rule: Rule, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(rule.body);
  return match?.[1].trim();
}

/** Classes, attributes and pseudo-classes (the argument of :not() counts, :not itself does not). */
function specificity(selector: string): number {
  return (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!not\b)[\w-]+/g) ?? []).length;
}

describe('waiting tray (session dashboard)', () => {
  it('keeps the compact bar pinned to the bottom of the screen while it is stuck', () => {
    const base = rulesFor('.waiting-queue').filter((r) => declared(r, 'position') === 'sticky');
    expect(base.length).toBe(1);
    expect(declared(base[0], 'bottom')).toBe('0');
  });

  it('lets the opened tray rejoin the page instead of staying pinned over it', () => {
    const open = rulesFor('.waiting-queue:not(.is-stuck)');
    expect(open.length).toBe(1);
    expect(open[0].media).toBeNull();
    expect(declared(open[0], 'position')).toBe('static');
  });

  it('keeps the wide-screen rail sticky, and outranks the opened-tray rule', () => {
    const rail = rulesFor('.dashboard:not(.is-ended) > .waiting-queue').filter(
      (r) => r.media?.includes('min-width: 90rem') && declared(r, 'position') === 'sticky',
    );
    expect(rail.length).toBe(1);
    expect(declared(rail[0], 'top')).toBeDefined();
    const open = rulesFor('.waiting-queue:not(.is-stuck)')[0];
    expect(specificity(rail[0].selector)).toBeGreaterThan(specificity(open.selector));
  });
});
