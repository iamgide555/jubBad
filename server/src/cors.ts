/**
 * Permissive CORS is a local-dev convenience only. In production the app is
 * served same-origin (nginx proxies `/api/` to this service, see
 * `web/nginx.conf`), so an unset `CORS_ORIGINS` should mean "no cross-origin
 * caller", not "every origin" — the API has no auth, so a wide-open default
 * would let any page drive any session whose code it knows.
 */
export function parseCorsOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean | string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return nodeEnv === 'production' ? [] : true;
  }
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
