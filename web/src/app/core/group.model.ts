export interface Group {
  code: string;
  name: string | null;
  /** Set whenever a new session is confirmed for this group — lets
   * GroupEntry offer to resume it instead of forcing a fresh paste. */
  lastSessionCode: string | null;
}
