/** One row of GET /groups, as far as the same-name warning needs it. `mine` is present only for an admin. */
export interface OwnGroupRow {
  code: string;
  name: string | null;
  mine?: boolean;
}

/** Trimmed, inner whitespace collapsed, Latin case folded. Thai has no case, so it compares as typed. */
export function sameGroupName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return norm(a) === norm(b);
}

/**
 * The caller's own group already using `name`, if any. Other hosts' rows (an
 * admin's `mine: false`) never count: the warning must not reveal or depend on
 * anyone else's groups. `exceptCode` skips the group being renamed.
 */
export function findOwnDuplicate(
  groups: readonly OwnGroupRow[],
  name: string,
  exceptCode?: string
): { code: string; name: string } | null {
  const hit = groups.find(
    (g) => g.mine !== false && g.code !== exceptCode && g.name !== null && sameGroupName(g.name, name)
  );
  return hit ? { code: hit.code, name: hit.name! } : null;
}
