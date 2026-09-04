export function parseCorsOrigins(raw: string | undefined): boolean | string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
