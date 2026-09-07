/**
 * Same-origin in dev, exactly as in production.
 *
 * This used to be http://localhost:3000, which made dev cross-origin while
 * production is same-origin through nginx. That difference matters now the
 * credential is an httpOnly cookie: a cross-site cookie needs SameSite=None,
 * which needs Secure, which needs HTTPS — none of which local dev has. Rather
 * than weaken the cookie to suit dev, dev gets a proxy (proxy.conf.json) and
 * matches production instead.
 */
export const environment = {
  apiBaseUrl: '/api',
};
