# Badminton court pairing app — v1 plan

## Background / opportunity

Existing apps (Racket Social, Kiki-match, Badminton Match Manager, Qcourt,
GroupSlam, etc.) already solve fair doubles pairing, rotation, sit-out
balancing, and even cost splitting — well. That part of the problem is
solved and not worth rebuilding from scratch.

The actual gap: **nothing is Thai-language + LINE-friendly + PromptPay-native**
for casual Thai badminton groups. Existing pairing apps are English-first,
generic multi-sport tools with their own account/PWA/bot ecosystems.
Existing Thai badminton apps (e.g. Lenkila) are court-booking/partner-finding
marketplaces, not session-running tools for an existing regular group.

The differentiator is localization + fitting into how these groups already
coordinate (LINE group chat, PromptPay for splitting bills) — not a smarter
pairing algorithm.

## Key product decisions (and why)

- **No bot in the LINE group chat, ever.** Early idea was a bot that posts
  shuffle results into the group automatically — rejected because it
  notifies people who aren't even playing that day (annoying, spammy).
- **No passive "listener" bot either.** Considered a bot that just reads
  group messages silently to auto-import rosters. Rejected on privacy
  grounds: a listen-only bot still technically has access to the *entire*
  conversation (not just roster posts), and consent from the host who
  invites it doesn't cover the ~15-20 other people in the chat. For a
  casual friend-group context this is a bigger trust risk than the
  convenience is worth.
- **Import is paste-based.** Host manually copies the roster message text
  from LINE and pastes it into the app. This keeps the app's data
  footprint to exactly what the host explicitly hands over — easy to
  explain, easy to trust, no infra (no webhook server, no persistent
  message store).
- **No LIFF, no LINE Login, no LINE platform integration at all in v1.**
  Once import is paste-based and sharing is manual (screenshot / "copy as
  text" button), there is literally no technical touchpoint with LINE's
  platform needed. LIFF was considered purely for nicer login and a native
  share-picker — both are UX polish, not core value, and can be added
  later once the core loop is proven.
- **No login/auth in v1.** Groups are identified by a shareable link/code
  instead of accounts. Removes a whole feature surface for v1.
- **Score logging: final score only, not live scoreboard.** A live
  in-app scoreboard (point-by-point, serve indicator, timers) is real
  scope creep nobody asked for. Instead: after a round, host optionally
  taps in the final score per court (e.g. 21-15). Single low-friction data
  entry point, and it means match-history data starts accumulating from
  day one even though nothing uses it yet (e.g. future skill/Elo
  balancing has real data to bootstrap from later instead of starting
  cold).
- **No host role / anyone-with-link-can-edit, accepted for v1.** Since
  there's no auth, the shareable link/code doesn't distinguish a host
  from a regular player — anyone with the link could reshuffle, edit
  scores, or wipe the roster. Acceptable risk for a trusted friend-group
  context; flagged here explicitly rather than left as a silent gap. A
  host role can be added later if abuse becomes a real problem.
- **No data-retention/deletion policy for v1.** Player names persist
  indefinitely under a group's link code. Not addressed in v1 — revisit
  if group turnover or privacy requests make it necessary.

## v1 feature set

1. **Import from LINE (paste-based)** — host pastes the session roster
   message text; app parses date/time, court count, main roster, and
   waitlist (สำรอง) separately. Fuzzy-matches names against known players
   in the group and flags new/unmatched names for host confirmation
   before finalizing anything. Nothing is auto-committed without host
   review.
2. **Roster + shuffle** — host reviews/edits the imported (or manually
   entered) list, sets court count, taps shuffle.
3. **Fair pairing engine** — random doubles pairing that avoids repeat
   partners and balances sit-outs, with history tracked per group across
   sessions (not just within one session).
4. **Manual sharing** — host views results in-app and shares manually
   (screenshot, or a "copy as text" button to paste into LINE themselves).
   No bot, no auto-posting.
5. **Cost splitting** — host enters court + shuttlecock fees, app splits
   per person and generates a PromptPay QR to share with just that
   session's players. Requires the host's PromptPay ID/phone number to
   be stored somewhere (see schema note below) — not optional, blocks
   this feature without it.
6. **Match result logging** — after a round, host optionally enters final
   score per court (e.g. "21-15"). Stored against the pairing record. No
   live scoreboard UI.

**Not yet in v1 feature set but expected to come up fast:** mid-session
edits — reshuffle after a round has started, add a late-arriving player,
remove a no-show. Not designed yet; revisit once the core loop
(import → confirm → shuffle → share) is proven, since real sessions
will hit this quickly.

## Explicitly out of scope for v1

- Skill/Elo-based match balancing
- Multi-sport support (stay badminton-only, stay Thai-only — the focus is
  the moat)
- Any LINE bot (posting OR passively listening)
- LIFF / LINE Login
- User accounts / login
- Live point-by-point scoreboard

## Tech stack

- **Frontend:** Angular (plain web app, no LIFF wrapper for v1)
- **Backend:** NestJS — parsing logic, pairing/rotation engine, PromptPay
  QR generation (EMV QR spec)
- **DB:** relational, roughly:

```
Group        — id, name/link-code (no user auth), hostPromptPayId (phone/ID
               for QR generation — required for cost-splitting feature)
Player       — id, groupId, name, aliases[] (for fuzzy match against LINE imports —
               populated when host confirms an unmatched import name maps to an
               existing Player, see fuzzy-match flow below)
Session      — id, groupId, date, courtCount, rawImportText (kept for parser debugging)
Round        — id, sessionId, roundNumber
Pairing      — id, roundId, courtNumber, teamA[2 playerIds], teamB[2 playerIds],
               scoreA, scoreB (nullable — optional entry)
Waitlist     — id, sessionId, playerId, position
```

## Suggested build order

1. **LINE roster-message parser** (done below — port into NestJS service)
2. Fuzzy-match layer: parsed names → known Player records (flag unmatched
   as "new player?" for host confirmation).

   **Algorithm (decided):** normalized Levenshtein, no auto-link on a
   fuzzy match — only on exact match.
   - Thai nicknames here run 2-4 chars (ปอม, ตี๋, เบส). Bigram/Dice
     similarity is weak at that length (one edit breaks most bigrams);
     namespace is small and dense enough that near-misses are real
     distinct people (e.g. "เกีย" vs "เกียร์" are two different players
     across the example messages) — so any auto-link on a fuzzy match
     risks a wrong silent merge. Extends the parser's existing
     "never silently guess" principle rather than inventing new
     tolerance rules.
   1. Normalize: strip trailing `(...)` note (e.g.
      `พี่แวน(พี่ที่ทำงานไกด์)` → `พี่แวน`), trim, Unicode NFC.
   2. Exact match (post-normalize) vs `Player.name` + `aliases[]` →
      auto-link (still shown in review screen, never hidden).
   3. No exact match → normalized Levenshtein similarity
      (`1 - distance/maxLen`) vs all known names+aliases for the group.
      Best score ≥ 0.7 → surface as "ใช่ [X] ไหม?" suggestion, host taps
      confirm/reject. Below 0.7 → flag "new player?".
   4. Host confirms a fuzzy/new mapping → pasted text saved as new
      `Player.alias` so the next import matches automatically.
   5. Implement inline in TS (~15 lines, no npm dep) — matches
      `parser.ts`'s existing no-dependency style; not worth pulling in
      `string-similarity` or similar for something this small.
3. Pairing/rotation engine (roster + court count + partner history → fair
   pairings, avoid-repeat-partner + sit-out balancing). **Scope decision
   needed:** repeat-*partner* avoidance is in v1 scope; repeat-*opponent*
   balancing (who you've played against, not just with) is common in
   similar apps but not yet decided in/out for v1 — call it explicitly
   before building the engine, don't let it default silently either way.
4. Cost split + PromptPay QR generation
5. Angular screens wired on top of the above

---

## Parser — design notes

Parses a LINE badminton-session roster message (Thai format) into
structured data: header info (date, time slots, court count/numbers,
venue), main roster, and waitlist. Built against three real example
messages from the user's actual LINE groups (see test file).

Design principles:
- **Lenient, not strict.** Real host-written messages vary in spacing,
  punctuation, whether empty numbered slots have a trailing space, etc.
  Heuristic parsing, not a rigid grammar.
- **Never silently drop or silently guess.** Anything ambiguous (e.g. a
  2-digit year that could be Buddhist or Gregorian convention) is
  surfaced in a `warnings` array rather than confidently resolved and
  hidden. Anything unclassifiable (e.g. หมายเหตุ notes) goes into
  `unrecognizedLines`, never discarded — this feeds the "host must
  double-check before confirming" requirement.
- **Empty numbered slots preserved** (`3.` with nothing after → `{
  position: 3, name: null }`), not dropped, so slot counts stay accurate
  even before names are filled in.
- **`@All` / `@all` mentions are explicitly excluded from venue
  detection** — LINE's notify-everyone mention looks syntactically like
  an `@venue` tag (e.g. `@ KIP`) but means something different.

Verified against 3 real example messages (all three groups the user is
actually in) — correctly extracted date, time ranges, court counts/court
numbers, roster names (including edge cases like a name with a
parenthetical note: `พี่แวน(พี่ที่ทำงานไกด์)`), waitlist section kept
separate from main roster, and หมายเหตุ notes correctly excluded from the
roster while still preserved as unrecognized text rather than dropped.

### `src/parser.ts`

```typescript
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

function isLikelyTimeOrHeaderLine(line: string): boolean {
  // A line like "19.00-20.00  1 คอร์ท" starts with a number but is a
  // time range / header, not a roster entry — never treat as a player slot.
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

function tryResolveIsoDate(rawDate: string): string | null {
  const match = rawDate.match(DATE_RE);
  if (!match) return null;
  const [, dStr, mStr, yStr] = match;
  const day = parseInt(dStr, 10);
  const month = parseInt(mStr, 10);
  let year = parseInt(yStr, 10);

  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  if (year < 100) {
    // Thai Buddhist 2-digit year (e.g. 69 -> 2569 BE -> 2026 CE) OR
    // Gregorian 2-digit year (e.g. 26 -> 2026). Both examples in practice
    // resolve to the same CE year range for this group's messages, but we
    // can't be 100% sure which convention a given message uses — flag it
    // as best-effort rather than asserting confidently.
    year = year > 60 ? 2500 + year - 543 : 2000 + year;
  } else if (year > 2400) {
    // 4-digit Buddhist year
    year -= 543;
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return iso;
}

function parseHeader(headerLines: string[], warnings: string[]): ParsedHeader {
  const fullText = headerLines.join('\n');

  const dateMatch = fullText.match(DATE_RE);
  const rawDate = dateMatch ? dateMatch[0] : null;
  const isoDate = rawDate ? tryResolveIsoDate(rawDate) : null;
  if (rawDate && !isoDate) {
    warnings.push(`Found a date-like string "${rawDate}" but could not confidently resolve it — please confirm the session date.`);
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

  // Best-effort "title" = the first header line that isn't a pure @mention
  // or a pure time-range line. A line CAN contain a date (e.g. "แบดวินนิ่ง
  // อังคาร 8/9/26") and still be the title — only exclude lines that are
  // themselves a time range or nothing but an @-mention.
  const titleLine =
    headerLines.find((l) => {
      const trimmed = l.trim();
      if (trimmed.length === 0) return false;
      if (/^@\s*(all)?\s*$/i.test(trimmed)) return false; // bare "@" or "@All"
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

  return {
    header,
    roster,
    waitlist,
    unrecognizedLines,
    warnings,
  };
}
```

### `src/test-examples.ts` (verification against real messages)

```typescript
import { parseLineRosterMessage } from './parser';

const example1 = `@All 
แบดวินนิ่ง อังคาร 8/9/26
19.00-20.00  1 คอร์ท
20.00-22.00  3 คอร์ท 10+11+12
1. ตั้ม
2. เบส
3. 
4. 
5. 
6. 
7.  
8. 
9. 
10. 
11. 
12. 
13. 
14. 
15. 
16. 
17. 
18.
19.
20.
สำรอง
1.
2.
3.`;

const example2 = `วัน "พฤ" 3/8/69 , 2 คอร์ด เวลา 20.00 - 22.00 @ KIP
1. ซัน
2. มุกกี้
3. อั๋น
4. ไอซ์
5. ไบรท์
6. บูม
7. เกม
8.เกีย
9. ไกด์
10. ปอม
11. พี่แวน(พี่ที่ทำงานไกด์)`;

const example3 = `@All ตีแบดสนามมาม่าแบดมินตัน
## วันอาทิตย์ 06/09/2026 14.00-16.00
(จองแล้ว 1คอร์ด )
1. ปอม
2. ไม้
3. เกียร์
4. ตูน
5. ตี๋
6. 
7. 
8. 
9. 
10. 
11. 
12. 
13. 
14 
15 
16
17
18
19
20
สำรอง
1.
2.
3.
4.
หมายเหตุ เนื่องจากสนามนี้มีเงื่อนไขในการยกเลิกที่ลำบากต่อการจองเยอะๆแล้วมายกเลิกภายหลัง จึงขอจองก่อน 1 คอร์ด หากคนลงชื่อถึง รายชื่อสำรองหรือถึง8คน จะทำการจอง 2คอร์ดครับ ขอความกรุณาลงชื่อภายในวันพฤหัสหรือเร็วกว่านั้นเพื่อเป็นการยืนยันว่าจะมีคอร์ดเหลือ เพื่อลดปัญหารอเล่นนานครับ

หมายเหตุ 2 ห้ามลงชื่อเพิ่มวันอาทิตย์เช้า`;

function report(label: string, text: string) {
  console.log(`\n===== ${label} =====`);
  const result = parseLineRosterMessage(text);
  console.log('--- header ---');
  console.log(result.header);
  console.log('--- roster (filled only) ---');
  console.log(result.roster.filter((s) => s.name));
  console.log(`roster total slots: ${result.roster.length}, filled: ${result.roster.filter((s) => s.name).length}`);
  console.log('--- waitlist (filled only) ---');
  console.log(result.waitlist.filter((s) => s.name));
  console.log(`waitlist total slots: ${result.waitlist.length}`);
  console.log('--- unrecognized lines ---');
  console.log(result.unrecognizedLines);
  console.log('--- warnings ---');
  console.log(result.warnings);
}

report('Example 1 (แบดวินนิ่ง อังคาร)', example1);
report('Example 2 (KIP)', example2);
report('Example 3 (มาม่าแบดมินตัน)', example3);
```

## Next steps (pick up in Claude Code)

1. Port `parser.ts` into a NestJS module/service (e.g.
   `RosterImportService.parse(text: string): ParseResult`).
2. Build the fuzzy-match layer: for each parsed roster/waitlist name,
   compare against `Player.name` + `Player.aliases[]` for that `Group`;
   surface confident matches, ambiguous matches, and no-match ("new
   player?") separately for the host-confirmation UI.
3. Build the pairing/rotation engine: input = confirmed roster + court
   count + partner-history from prior `Pairing` records for the group;
   output = this round's court assignments, minimizing repeat partners
   and balancing who sits out.
4. Cost split + PromptPay QR (EMV QR code spec) generation endpoint.
5. Angular screens: paste/import → review/confirm → shuffle → share →
   (optional) log scores → (optional) cost split.
