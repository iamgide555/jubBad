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

/** One distinct positive amount anywhere on the slip, independent of tonight's bill. Ambiguous OCR needs host review. */
export function slipAmount(text: string): number | null {
  const values = [...amountsIn(text)].filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647);
  return values.length === 1 ? values[0] : null;
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

// Memo labels, compared with all whitespace removed (OCR splits Thai words).
const THAI_MEMO_LABELS = ['บันทึกช่วยจำ', 'บันทึก', 'ช่วยจำ'];
// Latin labels must be whole words, so `Notebook` is not a label.
const LATIN_MEMO_LABEL = /^(?:memo|note)(?![a-z])/i;
const LEADING_NON_LETTER = /^[^฀-๿A-Za-z]+/;

/** True when the line starts with a memo label (after leading non-letter noise). */
function isMemoLabel(line: OcrLine): boolean {
  const text = line.text.replace(LEADING_NON_LETTER, '');
  if (LATIN_MEMO_LABEL.test(text)) return true;
  const squeezed = text.replace(/\s+/g, '');
  return THAI_MEMO_LABELS.some((label) => squeezed.startsWith(label));
}

/**
 * The lines above the first memo label. The memo is free text the sender
 * types, so it may hold a title and the host's name (on the label's line or
 * under it); nothing at or below the label may become the receiver. Slips
 * print the memo below both name blocks. A label above the receiver is not a
 * supported layout: the receiver is then dropped too, so the slip fails closed
 * (held for the host), which is the safe direction.
 */
function aboveMemo(sorted: OcrLine[]): OcrLine[] {
  const label = sorted.find(isMemoLabel);
  return label === undefined ? sorted : sorted.filter((l) => l.y0 < label.y0);
}

/** The receiver's name text with the title removed, or null if there is none. */
function selectReceiver(lines: OcrLine[]): string | null {
  const sorted = aboveMemo([...lines].sort((a, b) => a.y0 - b.y0));
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

// ---------------------------------------------------------------------------
// Slip date
// ---------------------------------------------------------------------------

/** A calendar date printed on a slip, Gregorian year, month 1-12. */
export interface SlipDate {
  year: number;
  month: number;
  day: number;
}

// Thai abbreviations as their two parts (ต.ค. is ต + ค); dots and OCR spaces
// between and after the parts are optional. A part may be a character class
// of what OCR reads it as: on real slips ต came back as the Thai digit ๓.
const THAI_MONTH_ABBR: [string, string][] = [
  ['ม', 'ค'],
  ['ก', 'พ'],
  ['มี', 'ค'],
  ['เม', 'ย'],
  ['พ', 'ค'],
  ['มิ', 'ย'],
  ['ก', 'ค'],
  ['ส', 'ค'],
  ['ก', 'ย'],
  ['[ต๓]', 'ค'],
  ['พ', 'ย'],
  ['ธ', 'ค'],
];
const THAI_MONTH_FULL = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];
const ENGLISH_MONTH = [
  'jan(?:uary)?',
  'feb(?:ruary)?',
  'mar(?:ch)?',
  'apr(?:il)?',
  'may',
  'june?',
  'july?',
  'aug(?:ust)?',
  'sep(?:t(?:ember)?)?',
  'oct(?:ober)?',
  'nov(?:ember)?',
  'dec(?:ember)?',
];

const LETTER = '[\\u0E01-\\u0E4EA-Za-z]';
// Thai vowel and tone marks OCR sometimes leaves stray after the dot (ต.ุค.).
// Only after a dot, so มีค (March) is never read as มค (January).
const STRAY_MARKS = '\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E';
// One capture group per month (1-12): full Thai name first, then the
// abbreviation, then English, each with an optional trailing dot.
const MONTH_GROUPS = THAI_MONTH_FULL.map((full, i) => {
  const [a, b] = THAI_MONTH_ABBR[i];
  const abbr = `${a}\\s*(?:\\.[\\s${STRAY_MARKS}]*)?${b}\\.?`;
  return `(${full}|${abbr}|${ENGLISH_MONTH[i]}\\.?)`;
}).join('|');
// Day, month as a whole token (no letter right before or after it), year.
// The year may not be the hour of a time (`22:11`), so a slip with no year
// printed is not read as one.
const SLIP_DATE = new RegExp(
  `(?<!\\d)(\\d{1,2})[\\s.,\\-]*(?<!${LETTER})(?:${MONTH_GROUPS})(?!${LETTER})` +
    `[\\s.,\\-]*(\\d{4}|\\d{2})(?!\\d)(?![:.]\\d)`,
  'gi',
);

function gregorianYear(digits: string): number | null {
  const n = Number(digits);
  if (digits.length === 2) return 2500 + n - 543;
  if (n >= 2400) return n - 543;
  if (n >= 1900 && n <= 2199) return n;
  return null;
}

/**
 * The first date printed on the slip (`29 ต.ค. 2569`, `29 ต.ค. 69`,
 * `29 Oct 2026`), or null when none can be read or it is not a real date.
 * A 2-digit year is Buddhist (25yy); a 4-digit year is Buddhist from 2400.
 */
export function slipDate(text: string): SlipDate | null {
  for (const match of text.matchAll(SLIP_DATE)) {
    const day = Number(match[1]);
    const month = match.slice(2, 14).findIndex((g) => g !== undefined) + 1;
    const year = gregorianYear(match[14]);
    if (year === null || month === 0) continue;
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) continue;
    return { year, month, day };
  }
  return null;
}

const DAY_MS = 86_400_000;
// Thailand is UTC+7 all year (no daylight saving).
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

function bangkokDay(at: Date): number {
  return Math.floor((at.getTime() + BANGKOK_OFFSET_MS) / DAY_MS);
}

/**
 * Is the slip dated within this bill's window: from the day before the bill
 * ended (a player who paid during the evening) to the day after today (a
 * phone clock a little ahead), in Bangkok calendar days? No date is never in.
 */
export function slipDateInWindow(
  date: SlipDate | null,
  billEnd: Date,
  now: Date,
): boolean {
  if (date === null) return false;
  const day = Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
  return day >= bangkokDay(billEnd) - 1 && day <= bangkokDay(now) + 1;
}
