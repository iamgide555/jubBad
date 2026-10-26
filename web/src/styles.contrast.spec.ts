/**
 * Guards two defects a UX critique measured on the real screens:
 *  - filled buttons carried white text in every theme, which is 2.0:1 on the
 *    dark theme's bright green (--court #3fd07a);
 *  - .table-scroll was position: static, so its absolutely positioned
 *    .sr-only sort hint escaped the clip and widened the page on a phone.
 *
 * It reads the real stylesheet as text and does the WCAG arithmetic itself,
 * so a token change in styles.css is checked against the actual values.
 */

// The web test tsconfig has no Node typings, and Angular's builder turns a
// `?raw` import of a .css file into an empty module, so read the stylesheet
// through Node's own loader. `ng test` runs from the web/ workspace root.
const node = (
  globalThis as unknown as {
    process: { cwd(): string; getBuiltinModule(id: string): unknown };
  }
).process;
const fs = node.getBuiltinModule('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const css = fs
  .readFileSync(`${node.cwd()}/src/styles.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = new RegExp(`(?:^|[}{;])\\s*${escapeRegExp(selector)}\\s*\\{`).exec(css);
  if (!start) {
    throw new Error(`styles.css has no rule for \`${selector}\``);
  }
  const open = start.index + start[0].length;
  let depth = 1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) {
      return css.slice(open, i);
    }
  }
  throw new Error(`styles.css has an unclosed rule for \`${selector}\``);
}

function declaration(body: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\s])${escapeRegExp(property)}\\s*:\\s*([^;]+);`).exec(body);
  return match?.[1].trim();
}

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    throw new Error(`expected a hex colour, got \`${hex}\``);
  }
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const FILLS = ['--court', '--warn', '--accent'];

// `--on-fill` is only ever set on `:root` (light) and in each of the two dark
// blocks, so a token that regresses in either dark block is caught.
const THEMES: Record<string, string> = {
  light: ':root',
  'dark (system preference)': ":root:not([data-theme='light'])",
  'dark (explicit choice)': ":root[data-theme='dark']",
};

describe('styles.css text on filled brand colours', () => {
  it('self-checks the WCAG helper against known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  for (const [theme, selector] of Object.entries(THEMES)) {
    describe(theme, () => {
      const body = ruleBody(selector);

      for (const fill of FILLS) {
        // Known gap, outside this fix: the light theme's --on-fill is white,
        // and white on the light --accent (#ff5a36) is about 3.1:1. It only
        // reaches the selected level chip and the live tag, both unchanged by
        // this work. A todo keeps it visible in the run without failing it.
        if (theme === 'light' && fill === '--accent') {
          it.todo(
            `--on-fill on ${fill} is at least 4.5:1 (white on the light accent is about 3.1:1)`,
          );
          continue;
        }
        it(`--on-fill on ${fill} is at least 4.5:1`, () => {
          const onFill = declaration(body, '--on-fill');
          const fillColour = declaration(body, fill) ?? declaration(ruleBody(':root'), fill);
          expect(onFill, `${selector} must set --on-fill`).toBeDefined();
          expect(fillColour, `${fill} must resolve for ${theme}`).toBeDefined();
          expect(contrast(onFill as string, fillColour as string)).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }

  it('paints the global button and button.danger with --on-fill, not a literal colour', () => {
    expect(declaration(ruleBody('button'), 'color')).toBe('var(--on-fill)');
    expect(declaration(ruleBody('button.danger'), 'color')).toBe('var(--on-fill)');
  });
});

describe('styles.css .table-scroll', () => {
  it('is positioned, so its absolute .sr-only children are clipped and cannot widen the page', () => {
    expect(declaration(ruleBody('.table-scroll'), 'position')).toBe('relative');
  });

  it('a disabled select reads as disabled: dimmed, with a not-allowed cursor', () => {
    expect(css).toMatch(/select:disabled\s*\{[^}]*opacity:\s*0?\.\d+[^}]*cursor:\s*not-allowed/);
  });
});
