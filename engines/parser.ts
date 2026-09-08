/**
 * Parses a LINE badminton-session roster message (Thai format) into
 * structured data: session header info, main roster, and waitlist.
 *
 * Handles the common community-group format:
 *   1. @All
 *   แบดวินนิ่ง อังคาร 8/9/26
 *   19.00-20.00  1 คอร์ท
 *   20.00-22.00  3 คอร์ท 10+11+12
 *   1. ตั้ม
 *   2. เบส
 *   3.
 *   ...
 *   สำรอง
 *   1.
 *   2.
 *
 * Design notes:
 * - This is intentionally lenient/heuristic, not a strict grammar, because
 *   real host-written messages vary in spacing, punctuation, and whether
 *   trailing empty numbered slots have a trailing space or not.
 * - The parser NEVER silently drops ambiguous input — anything it can't
 *   confidently classify is surfaced in `warnings` so the host can review
 *   it before confirming the import (per the "host must double check" rule).
 */

export interface ParsedTimeSlot {
  /** Raw matched text, e.g. "19.00-20.00" */
  raw: string;
  startTime: string; // "19:00"
  endTime: string; // "20:00"
  courtCount: number | null;
  courtNumbers: number[] | null; // e.g. [10, 11, 12] if explicitly listed
}

export interface ParsedHeader {
  /** Raw date text as found, e.g. "8/9/26" or "06/09/2026" */
  rawDate: string | null;
  /** ISO date if we could confidently resolve it (best-effort only) */
  isoDate: string | null;
  venue: string | null;
  timeSlots: ParsedTimeSlot[];
  titleLine: string | null;
}

export interface ParsedPlayerSlot {
  position: number;
  name: string | null; // null = empty slot, not filled in yet
}

export interface ParseResult {
  header: ParsedHeader;
  roster: ParsedPlayerSlot[];
  waitlist: ParsedPlayerSlot[];
  /** Free-text lines the parser couldn't classify (notes, หมายเหตุ, etc.) */
  unrecognizedLines: string[];
  warnings: string[];
}

const WAITLIST_MARKERS = ['สำรอง', 'สํารอง'];
const NOTE_MARKERS = ['หมายเหตุ', 'note:', 'หมายเหตุ2', 'หมายเหตุ 2'];

/** Matches "1. ชื่อ", "1.ชื่อ", "1 ชื่อ", "14 " (no dot), "20" (bare number) */
const NUMBERED_LINE_RE = /^\s*(\d{1,3})\s*[.)]?\s*(.*)$/;

/** Matches "19.00-20.00" or "19:00-20:00" style time ranges */
const TIME_RANGE_RE = /(\d{1,2})[.:](\d{2})\s*-\s*(\d{1,2})[.:](\d{2})/g;

/** Matches a date like 8/9/26, 06/09/2026, 3/8/69 */
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;

/** Matches court-count phrases: "1 คอร์ท", "2 คอร์ด", "3 คอร์ท 10+11+12" */
const COURT_COUNT_RE = /(\d{1,2})\s*คอร์[ทด]/;

/** Matches explicit court numbers joined by '+', e.g. "10+11+12" */
const COURT_NUMBERS_RE = /(\d{1,2}(?:\s*\+\s*\d{1,2})+)/;

/**
 * Matches @-tags. LINE group messages use "@All" / "@all" as a
 * notify-everyone mention, not a venue — those must be excluded before
 * treating an @-tag as a venue name like "@ KIP".
 */
const AT_TAG_RE = /@\s*([^\s@][^\n]*)/g;
const ALL_MENTION_RE = /^all\b/i;

function isWaitlistMarker(line: string): boolean {
  const trimmed = line.trim();
  return WAITLIST_MARKERS.some((m) => trimmed.startsWith(m));
}

function isNoteMarker(line: string): boolean {
  const trimmed = line.trim();
  return NOTE_MARKERS.some((m) => trimmed.startsWith(m));
}

function isAllMention(value: string): boolean {
  return /^@\s*all\b/i.test(value.trim());
}

function isNumberedAllMention(line: string): boolean {
  const match = line.trim().match(NUMBERED_LINE_RE);
  return match !== null && isAllMention(match[2]);
}

function isLikelyTimeOrHeaderLine(line: string): boolean {
  // A line like "19.00-20.00  1 คอร์ท" starts with a number but is a
  // time range / header, not a roster entry — never treat as a player slot.
  //
  // TIME_RANGE_RE is /g, so `.test()` leaves lastIndex past the match it
  // found. Resetting is not optional here: without it a second time-range
  // line that matches earlier in its own string than the previous line's
  // lastIndex is missed, and "1.00-3.00  3 คอร์ท" then reads as roster entry
  // number 1 — the roster start lands on the time line, the block breaks on
  // it at once, and every real name is dropped with no warning.
  TIME_RANGE_RE.lastIndex = 0;
  return TIME_RANGE_RE.test(line) || /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line);
}

function parseTimeSlotLine(line: string): ParsedTimeSlot | null {
  TIME_RANGE_RE.lastIndex = 0;
  const match = TIME_RANGE_RE.exec(line);
  if (!match) return null;

  const [raw, h1, m1, h2, m2] = match;
  const courtCountMatch = line.match(COURT_COUNT_RE);
  const courtNumbersMatch = line.match(COURT_NUMBERS_RE);

  return {
    raw,
    startTime: `${h1.padStart(2, '0')}:${m1}`,
    endTime: `${h2.padStart(2, '0')}:${m2}`,
    courtCount: courtCountMatch ? parseInt(courtCountMatch[1], 10) : null,
    courtNumbers: courtNumbersMatch
      ? courtNumbersMatch[1].split('+').map((n) => parseInt(n.trim(), 10))
      : null,
  };
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  return isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function tryResolveIsoDate(rawDate: string): string | null {
  const match = rawDate.match(DATE_RE);
  if (!match) return null;
  const [, dStr, mStr, yStr] = match;
  const day = parseInt(dStr, 10);
  const month = parseInt(mStr, 10);
  let year = parseInt(yStr, 10);

  if (year < 100) {
    // Two digits are genuinely ambiguous: "26" could be 2026 CE, "69" could be
    // 2569 BE. Resolve on the convention these groups actually use — a value
    // above 60 can only be Buddhist, anything lower can only be Gregorian —
    // and let parseHeader warn so the host confirms the result.
    year = year > 60 ? 2500 + year - 543 : 2000 + year;
  } else if (year > 2400) {
    // 4-digit Buddhist year
    year -= 543;
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

function parseHeader(headerLines: string[], warnings: string[]): ParsedHeader {
  const fullText = headerLines.join('\n');

  const dateMatch = fullText.match(DATE_RE);
  const rawDate = dateMatch ? dateMatch[0] : null;
  const isoDate = rawDate ? tryResolveIsoDate(rawDate) : null;
  if (rawDate && !isoDate) {
    warnings.push(
      `Found a date-like string "${rawDate}" but it is not a real calendar date — please confirm the session date.`
    );
  } else if (rawDate && Number(rawDate.match(DATE_RE)?.[3]) < 100) {
    warnings.push(
      `The date "${rawDate}" has an ambiguous two-digit year — read as ${isoDate}, please confirm the session date.`
    );
  }
  if (!rawDate) {
    warnings.push('No date found in the header — please set the session date manually.');
  }

  let venue: string | null = null;
  AT_TAG_RE.lastIndex = 0;
  let atMatch: RegExpExecArray | null;
  while ((atMatch = AT_TAG_RE.exec(fullText)) !== null) {
    const candidate = atMatch[1].trim();
    if (ALL_MENTION_RE.test(candidate)) continue; // skip "@All" / "@all" mentions
    // Venue tags are short (e.g. "KIP"); take just the first word/token
    // rather than the whole rest of the line.
    venue = candidate.split(/\s{2,}|\n/)[0].trim();
    break;
  }

  const timeSlots: ParsedTimeSlot[] = [];
  for (const line of headerLines) {
    const slot = parseTimeSlotLine(line);
    if (slot) timeSlots.push(slot);
  }
  if (timeSlots.length === 0) {
    warnings.push('No time range (e.g. "19.00-20.00") found — please set the session time manually.');
  }

  // A session runs on one court count. When the message books a different
  // number of courts later in the evening we cannot honour that yet, and
  // silently taking the first (or the largest) count would either waste courts
  // or hand out courts that are not booked. Say so instead of guessing.
  const slotCounts = timeSlots
    .map((s) => s.courtCount)
    .filter((c): c is number => c !== null);
  if (new Set(slotCounts).size > 1) {
    const described = timeSlots
      .filter((s) => s.courtCount !== null)
      .map((s) => `${s.raw} → ${s.courtCount} courts`)
      .join(', ');
    warnings.push(
      `The court count changes during the session (${described}). Only the first slot's count is applied — ` +
        'adjust the court count on the session when the later slot starts.',
    );
  }

  // Best-effort "title" = the first header line that isn't a pure @mention
  // or a pure time-range line. A line CAN contain a date (e.g. "แบดวินนิ่ง
  // อังคาร 8/9/26") and still be the title — only exclude lines that are
  // themselves a time range or nothing but an @-mention.
  const titleLine =
    headerLines.find((l) => {
      const trimmed = l.trim();
      if (trimmed.length === 0) return false;
      if (/^@\s*(all)?\s*$/i.test(trimmed) || isNumberedAllMention(trimmed)) return false;
      TIME_RANGE_RE.lastIndex = 0;
      if (TIME_RANGE_RE.test(trimmed)) return false;
      return true;
    }) || null;

  return { rawDate, isoDate, venue, timeSlots, titleLine };
}

/**
 * Parses a run of numbered lines (roster or waitlist block) starting at
 * `startIndex` in `lines`, stopping at the first line that isn't a
 * plausible numbered player slot. Returns the parsed slots and the index
 * of the first line NOT consumed.
 */
function parseNumberedBlock(
  lines: string[],
  startIndex: number
): { slots: ParsedPlayerSlot[]; nextIndex: number } {
  const slots: ParsedPlayerSlot[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }
    if (isWaitlistMarker(trimmed) || isNoteMarker(trimmed)) {
      break;
    }
    if (isLikelyTimeOrHeaderLine(trimmed)) {
      break;
    }

    const match = trimmed.match(NUMBERED_LINE_RE);
    if (!match) {
      // Not a numbered line at all — end of this block.
      break;
    }

    const position = parseInt(match[1], 10);
    const name = match[2].trim();
    if (isAllMention(name)) {
      i++;
      continue;
    }
    slots.push({ position, name: name.length > 0 ? name : null });
    i++;
  }

  return { slots, nextIndex: i };
}

export function parseLineRosterMessage(text: string): ParseResult {
  const lines = text.split('\n');
  const warnings: string[] = [];
  const unrecognizedLines: string[] = [];

  // Find where the main roster starts: first line matching "1. <something-or-empty>"
  // that isn't itself a time/date line.
  let rosterStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (isLikelyTimeOrHeaderLine(trimmed)) continue;
    if (isNumberedAllMention(trimmed)) continue;
    const match = trimmed.match(NUMBERED_LINE_RE);
    if (match && parseInt(match[1], 10) === 1) {
      rosterStart = i;
      break;
    }
  }

  if (rosterStart === -1) {
    warnings.push('Could not find the start of a numbered roster list (expected a line starting with "1.").');
    return {
      header: parseHeader(lines, warnings),
      roster: [],
      waitlist: [],
      unrecognizedLines: lines.filter((l) => l.trim().length > 0),
      warnings,
    };
  }

  const headerLines = lines.slice(0, rosterStart);
  const header = parseHeader(headerLines, warnings);

  // Header lines the header parser made no use of are notes, and notes are
  // not disposable. Hosts routinely put "ค่าสนามคนละ 80" or "ใครมาสายบอกด้วย"
  // above the list, and everything above the first numbered line was being
  // read for a date, a time and a venue and then dropped — so a note placed
  // before the roster vanished while the identical note placed after it was
  // surfaced. That asymmetry is invisible to the host, which is exactly the
  // silent loss this parser is supposed to refuse.
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (header.titleLine !== null && trimmed === header.titleLine.trim()) continue;
    if (/^@/.test(trimmed) || isNumberedAllMention(trimmed)) continue;
    TIME_RANGE_RE.lastIndex = 0;
    if (TIME_RANGE_RE.test(trimmed)) continue;
    unrecognizedLines.push(trimmed);
  }

  const { slots: roster, nextIndex: afterRoster } = parseNumberedBlock(lines, rosterStart);

  // Look for a waitlist marker starting from where the main roster block ended.
  let waitlist: ParsedPlayerSlot[] = [];
  let i = afterRoster;
  while (i < lines.length && lines[i].trim() === '') i++;

  if (i < lines.length && isWaitlistMarker(lines[i])) {
    const { slots, nextIndex } = parseNumberedBlock(lines, i + 1);
    waitlist = slots;
    i = nextIndex;
  }

  // Anything left over (notes, trailing free text) — surfaced, not discarded.
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) unrecognizedLines.push(trimmed);
  }

  const filledRosterCount = roster.filter((s) => s.name).length;
  if (filledRosterCount === 0) {
    warnings.push('No names were found in the main roster — please check the pasted text.');
  }

  return { header, roster, waitlist, unrecognizedLines, warnings };
}
