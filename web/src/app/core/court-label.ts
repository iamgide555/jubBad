/**
 * A court's visible name: the host's per-session label, or its 1-based number.
 * `courtNumber` stays the identity everywhere; this is display only.
 */
export function labelForCourt(labels: readonly (string | null)[], courtNumber: number): string {
  return labels[courtNumber - 1] ?? String(courtNumber);
}
