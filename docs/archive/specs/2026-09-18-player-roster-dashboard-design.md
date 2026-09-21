# Player roster dashboard — design

Status: Implemented and merged (`797d182`, 2026-09-18). Archived 2026-09-21.
Plan: `docs/archive/plans/2026-09-18-player-roster-dashboard.md`.

> **Changed after merge.** The "Table columns" list below describes the
> first build. Since `9380fe3`, age, email and phone appear only as inputs
> while a row is being edited, not as columns in the row view. An in-progress
> edit is also now guarded against navigation, which this design did not
> cover. See the plan's "Implementation Notes (post-merge)".

**Goal:** Give a host a per-group screen to view and edit player contact
info (name, age, email, phone), alongside a rating/win-rate ranking.
Host-only — no self-service edit link for players, since a player
could otherwise edit anyone's row, not just their own.

**Context:** `Player` (`server/prisma/schema.prisma:75`) currently only
has `name`/`aliases`. There is no existing edit flow for player info —
`GroupEntry` only manages roster-text name matching plus group
rename/export/delete; `PlayerProfile` is a public, read-only stats
page reachable with no login (deliberately, so a player can hold the
link — see `player-profile.ts`'s `canGoBack` comment). That public-ness
is exactly why contact info must not ride along on the existing public
`GET /groups/:code/players` endpoint.

## Data model

Add to `Player` (migration `add_player_contact_info`):

```prisma
model Player {
  id      String @id @default(cuid())
  groupId String
  name    String
  aliases String // JSON-encoded string[]
  age     Int?
  email   String?
  phone   String?
  group   Group  @relation(fields: [groupId], references: [code])
  rosterEntries SessionRoster[]
  waitlistEntries Waitlist[]
}
```

All three new columns nullable — existing players show blank, no
backfill needed.

## API

Both new routes live on `GroupsController`, under `/groups/:code/...`.
`OwnershipGuard` already scopes any non-`@Public()` route under
`/groups/` to the group's owner (or an admin) by matching `:code` —
no guard changes needed. Neither new route gets `@Public()`.

- `GET /groups/:code/players/manage` — full player list: `id`, `name`,
  `aliases`, `age`, `email`, `phone`, plus `rating` (doubles Elo),
  `singlesRating` (nullable), `winRate` (nullable). Computed
  group-wide in one pass — reuse `computeRatingTracks` and the
  win/decisive tally already written per-player in
  `GroupsService.playerStats`, but run once over all of the group's
  players rather than calling the existing per-player method N times.
- `PUT /groups/:code/players/:playerId` — update `name`/`age`/`email`/
  `phone` on one player. Body: `UpdatePlayerDto`.

Existing `@Public() GET /groups/:code/players` (id/name/aliases only,
used by `resolvePlayerNames` for public displays) is untouched — this
is what keeps contact info off the public/no-login path.

### `UpdatePlayerDto`

```ts
class UpdatePlayerDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsInt() @Min(0) @Max(120) age?: number;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Matches(/^[0-9+\- ]{6,20}$/) phone?: string;
}
```

Same shape validated client-side before submit (mirrored rules in the
component); server DTO is the source of truth.

## Frontend

New page `PlayerRoster` at route `/g/:groupCode/players`, guarded the
same way as `GroupEntry` (host session cookie — this route is never
`@Public()` so an unauthenticated fetch 404s the same way an
unowned group does).

- Linked from `group-entry.html`, near the existing settings/danger
  zone area: "จัดการผู้เล่น" (manage players).
- Table columns: Name, Age, Email, Phone, Rank, Rating (doubles),
  Rating (singles), Win%.
  - Name/Age/Email/Phone are inline-editable per row (edit → save/
    cancel), following the `editingId`/`saveEdit` pattern already used
    in `admin.ts` for user rows.
  - Rank/Rating(doubles)/Rating(singles)/Win% are display-only,
    sourced from `/players/manage`.
  - Default sort: doubles rating, descending. Clicking the Rating
    (doubles) / Rating (singles) / Win% column header re-sorts by
    that metric; the Rank column always reflects the current sort
    (i.e. "rank" means "position under whatever metric is currently
    sorted", not four independent rank numbers).
  - A player with no singles rating (never played singles) shows the
    rating column blank, not 0 — same convention `playerStats`
    already uses (`singlesRating: null`).

## Testing

- Server: spec coverage for `UpdatePlayerDto` validation, the new
  controller routes (ownership-guarded, non-public), and the
  group-wide ranking computation in `GroupsService`.
- Web: component spec for `PlayerRoster` — loads/display, inline edit
  save/cancel, sort-by-column re-ranking — following existing
  `*.spec.ts` patterns (e.g. `admin.service.spec.ts`,
  `session-dashboard.spec.ts`).

## Out of scope

- No self-service/player-facing edit link (rejected — a single link
  could edit any player, not just the holder).
- No new stats beyond rating/singles-rating/win-rate — this reuses
  numbers `playerStats` already computes per-player, just batched.
