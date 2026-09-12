import { packSession, parseSession } from './session.js';

describe('session cookie payload', () => {
  it('round-trips a user id and token version', () => {
    const packed = packSession('user-abc123', 4);
    expect(parseSession(packed)).toEqual({ userId: 'user-abc123', tokenVersion: 4 });
  });

  it('treats an unsigned or missing cookie as absent', () => {
    // cookie-parser's req.signedCookies carries `false` on a bad signature and
    // `undefined` when the cookie is not present at all.
    expect(parseSession(false)).toBeNull();
    expect(parseSession(undefined)).toBeNull();
  });

  it('rejects a payload with no version separator', () => {
    expect(parseSession('just-a-user-id')).toBeNull();
  });

  it('rejects a payload with a non-numeric version', () => {
    expect(parseSession('user-abc:not-a-number')).toBeNull();
  });

  it('rejects an empty user id', () => {
    expect(parseSession(':4')).toBeNull();
  });

  it('handles a version of zero, which is the value every new user starts at', () => {
    expect(parseSession(packSession('user-abc123', 0))).toEqual({
      userId: 'user-abc123',
      tokenVersion: 0,
    });
  });
});
