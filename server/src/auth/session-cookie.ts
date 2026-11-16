import type { CookieOptions } from 'express';

/** Thirty days: the host should not re-authenticate before every session. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The options for the signed session cookie, shared by every route that signs a host in. */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    /**
     * Signed rather than plain: the cookie's payload is `userId:tokenVersion`
     * (session.ts), and a client that could forge or edit it could pick any
     * user id. cookie-parser verifies the signature against SESSION_SECRET
     * before AuthGuard ever sees the value.
     */
    signed: true,
    /**
     * Lax is what makes a separate CSRF token unnecessary: the browser will
     * not attach this cookie to a cross-site POST, so another origin cannot
     * drive the API using the host's own session.
     */
    sameSite: 'lax',
    /**
     * Only in production. Cloudflare terminates TLS so the browser sees
     * HTTPS and honours it there; over plain-http local dev a Secure cookie
     * is treated inconsistently between browsers and would silently not be
     * stored.
     */
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_MS,
  };
}
