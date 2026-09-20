/**
 * Baht <-> satang conversion for the host's shuttlecock-price editor. The
 * server stores price as integer satang (1 THB = 100 satang) and never
 * converts on its own — Task 1's report is explicit that this is entirely
 * this task's responsibility.
 *
 * Every function here works on the raw input *string*, never on a
 * `parseFloat`'d baht amount multiplied by 100. A plain `Number("9.35") *
 * 100` is 934.9999999999999 in IEEE754 double arithmetic (0.35 has no exact
 * binary fraction), so multiplying a parsed float by 100 is exactly the
 * off-by-one-satang bug this file exists to avoid. Splitting the string on
 * "." and treating the integer and fractional parts as separate whole
 * numbers keeps every intermediate value an exact integer.
 */

const MAX_INT32 = 2147483647;

export type ShuttleFieldParse =
  | { ok: true; value: number | null }
  | { ok: false };

const OK_BLANK: ShuttleFieldParse = { ok: true, value: null };
const INVALID: ShuttleFieldParse = { ok: false };

/** Trims and rejects anything empty-but-not-blank (e.g. whitespace only counts as blank). */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

/**
 * Shuttle count: a nonnegative whole number, or blank to mean "not recorded"
 * (sent as an explicit `null`). Matches the server's own validation range
 * (0..2147483647) so the UI never bounces off a 400 in normal use.
 */
export function parseShuttleCountInput(text: string): ShuttleFieldParse {
  if (isBlank(text)) return OK_BLANK;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return INVALID;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > MAX_INT32) return INVALID;
  return { ok: true, value };
}

/**
 * Shuttle price, entered in baht, converted to integer satang. Accepts a
 * nonnegative amount with at most 2 decimal places; blank means "not
 * recorded" (explicit `null`). Anything with a 3rd decimal digit is refused
 * outright rather than silently rounded — the brief is explicit that a
 * host's "80.505" must not quietly become "80.50" or "80.51".
 */
export function parseShuttlePriceInput(text: string): ShuttleFieldParse {
  if (isBlank(text)) return OK_BLANK;
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return INVALID;
  const [intPart, fracPartRaw] = trimmed.split('.');
  const fracPart = (fracPartRaw ?? '').padEnd(2, '0');
  const intValue = Number(intPart);
  const fracValue = Number(fracPart);
  // Both operands and the product/sum below are whole numbers well under
  // Number.MAX_SAFE_INTEGER, so this arithmetic is exact — no float drift.
  const satang = intValue * 100 + fracValue;
  if (!Number.isSafeInteger(satang) || satang > MAX_INT32) return INVALID;
  return { ok: true, value: satang };
}

/** `null` -> blank input (never "0"); otherwise the plain integer as text. */
export function formatShuttleCountInput(count: number | null): string {
  return count === null ? '' : String(count);
}

/**
 * `null` -> blank input; `0` -> "0"; otherwise a baht amount with two decimal
 * places whenever there are cents to show ("80" not "80.00", but "80.50" —
 * never a truncated "80.5"). Built from integer division/modulo on the
 * satang value, never from a float baht amount, for the same exactness
 * reason as the parse direction.
 */
export function formatShuttlePriceInput(satang: number | null): string {
  if (satang === null) return '';
  const whole = Math.trunc(satang / 100);
  const cents = satang % 100;
  return cents === 0 ? `${whole}` : `${whole}.${String(cents).padStart(2, '0')}`;
}
