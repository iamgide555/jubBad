// Pure matching rules for OCR text read off a bank-transfer slip: is an owed
// amount printed on it, and is the receiver the person the host saved?
// No I/O and no dependencies; the OCR itself lives elsewhere.

/** One recognised line of slip text with its vertical extent in the image. */
export interface OcrLine {
  text: string;
  y0: number;
  y1: number;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// A whole amount token: not glued to another number on either side (so
// `1172.00` does not contain `172.00`, and `1.172.00` contains nothing).
const AMOUNT_TOKEN =
  /(?<![\d,])(?<!\d\.)(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(?!\d)(?![,.]\d)/g;

function tokenToSatang(token: string): number {
  const [whole, fraction] = token.replace(/,/g, '').split('.');
  return Number(whole) * 100 + Number(fraction);
}

function amountsIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(AMOUNT_TOKEN)) {
    found.add(tokenToSatang(match[1]));
  }
  return found;
}

/** True when `satang` is printed in `text` as a whole amount token. Zero never is. */
export function amountPresent(text: string, satang: number): boolean {
  if (!Number.isInteger(satang) || satang <= 0) return false;
  return amountsIn(text).has(satang);
}

/** True when `text` holds any whole amount token (same token rules as `amountPresent`), zero included. */
export function hasAmountToken(text: string): boolean {
  return amountsIn(text).size > 0;
}

/** The distinct values of `owedSatang` that are printed in `text`, in input order. */
export function owedAmountsFound(text: string, owedSatang: number[]): number[] {
  const present = amountsIn(text);
  const result: number[] = [];
  for (const satang of owedSatang) {
    if (
      Number.isInteger(satang) &&
      satang > 0 &&
      present.has(satang) &&
      !result.includes(satang)
    ) {
      result.push(satang);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Receiver name
// ---------------------------------------------------------------------------

// Longer titles first so นางสาว is not read as นาง and Mrs not as Mr.
const TITLES = [
  'นางสาว',
  'น.ส.',
  'นส.',
  'น.ส',
  'นาย',
  'นาง',
  'miss',
  'mrs',
  'mr',
  'ms',
];

const LEADING_NOISE = /^[^฀-๿A-Za-z0-9]+/;
const TRAILING_NOISE = /[^฀-๿A-Za-z0-9]+$/;

function stripLeadingNoise(text: string): string {
  return text.replace(LEADING_NOISE, '');
}

/**
 * If `text` starts with a title (whitespace between its characters ignored,
 * Latin case-insensitive), the text after it with leading punctuation and
 * spaces dropped; otherwise null.
 */
function afterTitle(text: string): string | null {
  const lower = text.toLowerCase();
  for (const title of TITLES) {
    let i = 0;
    let ok = true;
    for (const ch of title) {
      while (i < lower.length && /\s/.test(lower[i])) i += 1;
      if (lower[i] !== ch) {
        ok = false;
        break;
      }
      i += 1;
    }
    if (ok) return stripLeadingNoise(text.slice(i));
  }
  return null;
}

/** If `text` starts with a จาก / From label, the rest after it; otherwise null. */
function afterLabel(text: string): string | null {
  const match = /^(?:จาก|from)/i.exec(text);
  return match ? stripLeadingNoise(text.slice(match[0].length)) : null;
}

interface NameLine {
  /** The name with its title removed (not yet whitespace-collapsed). */
  name: string;
  /** A จาก / From label sits on the same line, before the title. */
  labelled: boolean;
  y0: number;
}

/** True when a word is exactly a จาก / From label (punctuation ignored). */
function isLabelWord(word: string): boolean {
  const rest = afterLabel(stripLeadingNoise(word));
  return rest !== null && rest.length === 0;
}

/**
 * A line is a name line when any whitespace-delimited word in it starts with a
 * title (OCR often puts the "to" label or an icon before it); the name is taken
 * from that word onward. A จาก / From label before the title marks it labelled.
 */
function parseNameLine(line: OcrLine): NameLine | null {
  const text = line.text;
  for (const word of text.matchAll(/\S+/g)) {
    const rest = stripLeadingNoise(text.slice(word.index));
    let name = afterTitle(rest);
    let glued = false;
    if (name === null) {
      // A label glued to the title, e.g. จากน.ส.
      const afterGlue = afterLabel(rest);
      name = afterGlue === null ? null : afterTitle(afterGlue);
      glued = name !== null;
    }
    if (name === null) continue;
    const before = text.slice(0, word.index).split(/\s+/);
    const labelled = glued || before.some((w) => w && isLabelWord(w));
    return { name, labelled, y0: line.y0 };
  }
  return null;
}

/** True when the whole line is just a จาก / From label. */
function isLabelOnly(line: OcrLine): boolean {
  const rest = afterLabel(stripLeadingNoise(line.text));
  return rest !== null && rest.length === 0;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The receiver's name text with the title removed, or null if there is none. */
function selectReceiver(lines: OcrLine[]): string | null {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
  const named: { entry: NameLine; index: number }[] = [];
  sorted.forEach((line, index) => {
    const entry = parseNameLine(line);
    if (entry) named.push({ entry, index });
  });
  if (named.length === 0) return null;

  let chosen: NameLine;
  if (named.length === 1) {
    const { entry, index } = named[0];
    if (entry.labelled) return null;
    if (index > 0 && isLabelOnly(sorted[index - 1])) return null;
    chosen = entry;
  } else {
    chosen = named[named.length - 1].entry;
  }
  const name = collapse(chosen.name);
  return name.length > 0 ? name : null;
}

/** The receiver block's text with its title removed; null when no receiver is found. */
export function receiverName(lines: OcrLine[]): string | null {
  return selectReceiver(lines);
}

function codePoints(word: string): string[] {
  return Array.from(word.replace(TRAILING_NOISE, '').toLowerCase());
}

/** Levenshtein distance between two code-point arrays, capped early at 2. */
function editDistanceAtMost1(a: string[], b: string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) {
    return a.slice(i + 1).join('') === b.slice(i + 1).join('');
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1).join('') === shorter.slice(i).join('');
}

function savedWords(savedName: string): string[][] {
  const words: string[][] = [];
  for (const raw of savedName.split(/\s+/)) {
    const cleaned = stripLeadingNoise(raw);
    if (cleaned.length === 0) continue;
    // A word that is nothing but a title is dropped.
    if (afterTitle(cleaned) === '') continue;
    const chars = codePoints(cleaned);
    if (chars.length > 0) words.push(chars);
  }
  return words;
}

/**
 * Does the slip's receiver correspond to `savedName`? Every saved word must be
 * a whole word of the receiver block; words of 5+ characters may differ by one
 * character (OCR misread). A saved name of only tiny words never matches.
 * OCR can truncate or misread a surname, so a first-name-only saved name is the
 * reliable case.
 */
export function receiverNameMatches(
  lines: OcrLine[],
  savedName: string,
): boolean {
  const words = savedWords(savedName);
  if (words.length === 0) return false;
  if (words.every((w) => w.length <= 2)) return false;

  const receiver = selectReceiver(lines);
  if (receiver === null) return false;
  const receiverWords = receiver
    .split(' ')
    .map((w) => stripLeadingNoise(w))
    .map(codePoints)
    .filter((w) => w.length > 0);

  return words.every((saved) =>
    receiverWords.some((candidate) => {
      if (saved.join('') === candidate.join('')) return true;
      return saved.length >= 5 && editDistanceAtMost1(saved, candidate);
    }),
  );
}

// ---------------------------------------------------------------------------
// Receiver account tail
// ---------------------------------------------------------------------------

// Mask characters: x/X, plus what OCR commonly reads the mask as (% * •).
const MASKED_NUMBER =
  /(?<![0-9A-Za-z])[0-9xX%*•](?:[-\s]?[0-9xX%*•])*(?![0-9A-Za-z])/g;

/**
 * The last 4 digits of a masked account number such as `xxx-xxx-5953`, or null.
 * With several masked numbers (sender above, receiver below) the lowest wins.
 */
export function receiverTail(text: string): string | null {
  let tail: string | null = null;
  for (const match of text.matchAll(MASKED_NUMBER)) {
    const candidate = match[0];
    const lastX = Math.max(
      ...['x', 'X', '%', '*', '•'].map((m) => candidate.lastIndexOf(m)),
    );
    if (lastX < 0) continue;
    // Whole digit groups after the last mask character, until there are four.
    const groups = candidate
      .slice(lastX + 1)
      .split(/[-\s]/)
      .filter((g) => g.length > 0);
    let digits = '';
    for (const group of groups) {
      digits += group;
      if (digits.length >= 4) break;
    }
    if (digits.length === 4) tail = digits;
  }
  return tail;
}
