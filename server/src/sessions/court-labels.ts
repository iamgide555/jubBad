/**
 * `Session.courtLabels` — per-court display-name overrides, JSON-encoded as
 * `(string | null)[]` in a TEXT column, index 0 = court 1. An unset slot
 * displays its 1-based number. Labels are presentation only: pairings,
 * routes, and history keep numeric `courtNumber`.
 *
 * Like `courtFormats`, a malformed stored value reads as "no labels" rather
 * than throwing, and the array is never trimmed when `courtCount` shrinks, so
 * readers index by court number and never read `.length` as a court count.
 */

export type CourtLabels = (string | null)[];

export function parseCourtLabels(raw: string | null): CourtLabels {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' && entry.trim() !== '' ? entry : null));
}

/** Trimmed NFC label, or null when blank (blank resets to the default number). */
export function normalizeCourtLabel(label: string): string | null {
  const normalized = label.normalize('NFC').trim();
  return normalized === '' ? null : normalized;
}

/** Writes one slot (label already normalized), padding any gap with null. */
export function withLabelAt(raw: string | null, courtNumber: number, label: string | null): string {
  const labels = parseCourtLabels(raw);
  while (labels.length < courtNumber) labels.push(null);
  labels[courtNumber - 1] = label;
  return JSON.stringify(labels);
}

/**
 * The highest court a host may label: the current count, any court that has
 * a pairing, and any court with a non-null override.
 */
export function editableCourtCount(
  courtCount: number | null,
  pairings: readonly { courtNumber: number }[],
  labels: readonly (string | null)[],
): number {
  let max = courtCount ?? 0;
  for (const p of pairings) max = Math.max(max, p.courtNumber);
  labels.forEach((label, i) => {
    if (label !== null) max = Math.max(max, i + 1);
  });
  return max;
}

function comparisonKey(label: string): string {
  return label.normalize('NFC').trim().toLocaleLowerCase();
}

/** Whether courts 1..count have two equal visible names (defaults included). */
export function hasDuplicateCourtLabels(labels: readonly (string | null)[], count: number): boolean {
  const seen = new Set<string>();
  for (let n = 1; n <= count; n++) {
    const key = comparisonKey(labels[n - 1] ?? String(n));
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
