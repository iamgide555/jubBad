# Group dashboard

## Intent and scope

After every session the host copies the summary and pastes it into the
group's LINE chat. With several groups this is repeated work. Each group gets
**one public dashboard** the host shares once (pinned in LINE): a list of
the group's sessions, each linking to its existing summary page, plus
all-time participation standings. Members check it themselves; the paste step
goes away.

Audiences: group members (public, read-only) and the host (creates and
revokes the link from the group page). The existing per-session summary,
display and bill pages are unchanged; their access rules already split host
and player.

Out of scope: ratings, levels, win/loss, links to player cards, trends or
charts, a "this month" toggle, pagination, a host-view link on the public
page.

## Decisions and why

- **Unguessable share token, not the group code.** A group code is chosen by
  the host ("pailin-thu"), so it is guessable. A public page keyed by it
  would expose any group's history to anyone who guesses the code. The
  dashboard is keyed by a random `Group.shareToken` instead, created on
  demand and revocable. Session summary links on the page keep using the
  session code, the existing trust model.
- **Standings rank by participation only** (sessions attended, then games
  played). No rating, level, or win/loss appears and names do not link to the
  player card. Casual groups run on social comfort: a public ranked list puts
  the weakest players in front of the whole chat. Levels are already host-only
  for the same reason (`docs/overview.md`, Ratings). The Elo data stays on
  the existing player card, reachable by its own link.
- **All-time standings.** Consistent with partner/opponent history being
  all-time. A recent-window toggle can be added if members ask.
- **Confirmed matches only.** A proposed match has not happened; same rule
  `GroupsService.listSessions` uses.

- **Linked summaries are unchanged and still public** (found in the final
  review). They carry win/loss, the group code and player ids. Accepted: the
  audience is the LINE group that already got each summary pasted. The
  dashboard's own "participation-only" claim covers the dashboard page, not the
  pages it links to.
- **"Live" is not just `endedAt = null`.** An unended session older than 24h is
  displayed as finished, so a forgotten "end session" does not read "playing
  now" forever.
- **Web distinguishes a 404 (link gone) from any other load failure** and shows
  a loading note, so a flaky connection never tells members the link was
  turned off.

## Data model

`Group.shareToken String? @unique`. One Prisma migration (nullable column plus
unique index). Token: 16 random bytes, base64url, generated server-side.
Check for undeployed migrations before rebuilding the home server.

## API

Owner-guarded (`AuthGuard` + `OwnershipGuard`; non-owner gets 404, never 403;
admin bypasses ownership):

- `GET /groups/:code/share` - `{ token: string | null }`, so the group page
  can show the current state. A code with no group is 404 (the ownership
  guard lets an unclaimed code through, so the service refuses it).
- `POST /groups/:code/share` - create the token if absent; return
  `{ token }`. Idempotent: a second call returns the same token, so the
  pinned link cannot be broken by tapping the button again, and two racing
  calls cannot mint two tokens. The web builds the link itself from
  `document.baseURI` (`core/share-link.ts`) because the server cannot know
  whether the host is on `/` (Thai) or `/en/`.
- `DELETE /groups/:code/share` - clear the token. The old link 404s at once.

Public (`@Public()`):

- `GET /dashboards/:token` returns
  `{ groupName, lastSessionDate, sessions[], standings[] }`.
  - `sessions`: newest first, at most 30. Each has `code`, `date`,
    `createdAt` (fallback when `date` is null), `venue`, `playerCount`,
    `matchCount`, `live` (not ended). No other fields. A session that has
    ended with no confirmed match (created, never played) is left out: there
    is nothing to show. A live session is always listed.
  - `playerCount` is the distinct players in that session's confirmed
    matches, not the pasted roster, so no-shows and waitlist do not inflate
    it.
  - `standings`: `{ name, sessionsAttended, gamesPlayed }`, sorted by
    sessionsAttended desc, gamesPlayed desc, name. `sessionsAttended` is the
    number of sessions in which the player was in at least one confirmed
    match; `gamesPlayed` is their confirmed matches. Players with none are
    omitted. Contains no player id, rating, level or contact data.
  - Unknown or revoked token: 404.

## Web

- New route `d/:token`, unguarded, lazy `GroupDashboard` page. Mobile-first
  (opened from LINE), Thai-primary with English locale, fonts keep Thai
  coverage.
  - Header: group name, last session date.
  - Session list: date, venue, players, matches, link to
    `/s/:code/summary`. A live session shows a "กำลังเล่น" badge and links to
    `/s/:code/display` (already public).
  - Standings table; names are plain text.
  - Empty state when the group has no sessions.
- Group page (`/g/:groupCode`): "Share dashboard" button. After sharing: the
  link, a copy button, and "Stop sharing" with a confirm step (it breaks the
  pinned LINE link).
- Add the route to `app.routes.ts` with the unguarded comment, and keep
  `app.routes.spec.ts` and `server/src/auth/auth.boundary.spec.ts` in
  agreement.

## Testing

Server (vitest, serial as configured):
- Token: created once, idempotent, URL-safe, unique across groups.
- `POST/DELETE` ownership: non-owner 404, admin allowed, unauthenticated
  refused.
- `GET /dashboards/:token`: unknown token 404, revoked token 404; payload has
  no rating/level/id/contact fields; unconfirmed matches do not count;
  zero-session players omitted; empty group returns empty arrays; 30-session
  cap; `live` flag.
- Boundary spec lists the new public route.

Web: component tests for empty, normal and live-session states; share panel
share/copy/revoke.

## Docs

Add a "Group dashboard" section to `docs/overview.md` recording the two
decisions above (token over group code; participation-only standings), so
neither is reversed by accident.
