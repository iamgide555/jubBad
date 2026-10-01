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

## Data model

`Group.shareToken String? @unique`. One Prisma migration (nullable column plus
unique index). Token: 16 random bytes, base64url, generated server-side.
Check for undeployed migrations before rebuilding the home server.

## API

Owner-guarded (`AuthGuard` + `OwnershipGuard`; non-owner gets 404, never 403;
admin bypasses ownership):

- `POST /groups/:code/share` - create the token if absent; return
  `{ token, url }`. Idempotent: a second call returns the same token, so the
  pinned link cannot be broken by tapping the button again.
- `DELETE /groups/:code/share` - clear the token. The old link 404s at once.

Public (`@Public()`):

- `GET /dashboards/:token` returns
  `{ groupName, lastSessionDate, sessions[], standings[] }`.
  - `sessions`: newest first, at most 30. Each has `code`, `date`, `venue`,
    `playerCount`, `matchCount`, `live` (not ended). No other fields.
  - `standings`: `{ name, sessionsAttended, gamesPlayed }`, sorted by
    sessionsAttended desc, gamesPlayed desc, name. Players with zero sessions
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
