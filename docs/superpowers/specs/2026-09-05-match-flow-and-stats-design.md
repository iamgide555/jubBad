# Match Flow and Player Stats Design

## Goal

Three features requested together after manual testing:

1. **Targeted swap** — reshuffle rerolls all 4 players on a pending
   court. If one player is tired/unavailable but the other 3 still
   want to play, a full reshuffle can bump one of the willing 3
   instead of the one who actually needs to sit out. Need a way to
   drop just the one player and pull in a substitute, leaving the
   other 3 untouched.
2. **Winner-button finish** — entering scoreA/scoreB on a touchscreen
   is poor UX ("finger web, lazy to enter score"). Replace the single
   "Finish match" button with two buttons — one per team — that both
   finish the match *and* record who won. Score fields stay, but
   become fully optional. Winner is stored explicitly so a future
   scoreboard (v2) can show win counts without depending on score
   data being present.
3. **Player stats table** — how many matches each player has played,
   and (depending on feature 2) how many they've won. Scoped per
   group, with a toggle between "this session" and "all-time."

## Decisions

### 1. Targeted swap — 1-for-1 substitute, no re-shuffle

New endpoint:

```
POST /sessions/:code/pairings/:pairingId/swap { playerId }
```

`SessionsService.swapPlayer(pairingId, playerId)`:
- Load the pairing. Reject (409) if `confirmedAt` or `endedAt` is
  already set — only a still-pending pairing can be swapped.
- Locate which team/slot `playerId` occupies in `teamA`/`teamB`.
- Compute the waiting pool exactly like `propose()` does: session
  roster minus players reserved by any other non-ended pairing, minus
  this pairing's own other 3 players.
- If the pool is empty, return `{ ok: false, reason: 'no-substitute' }`
  — nothing changes.
- Otherwise pick the substitute with the lowest
  `gamesPlayedThisSession` (via the existing `deriveHistory` helper,
  same fairness signal `selectSittingOut` already uses), tie-broken
  arbitrarily. Replace only that one slot in `teamA`/`teamB`; the
  other 3 positions are untouched.

No change to `generateRound`/`propose()` — this is a separate,
narrower operation, not a variant of reshuffle.

Client: in `CourtPanel`'s pending-court template, tapping a player's
name calls `swap(pairingId, playerId)`. If the pool is empty, show an
inline hint ("No one waiting to sub in") and the tap is a no-op —
mirrors the existing `notEnoughPlayers` hint pattern.

### 2. Winner-button finish — explicit `winner` field, scores stay optional

`Pairing` gains a nullable `winner` column (`'A' | 'B'`, string-typed
to match the existing `teamA`/`teamB` JSON-string convention rather
than introducing a Prisma enum for a two-value field). Existing rows
get `winner = null` — no backfill (see Non-goals).

`FinishPairingDto` gains:

```ts
@IsIn(['A', 'B'])
winner!: 'A' | 'B';
```

required from here on; `scoreA`/`scoreB` stay `@IsOptional()` exactly
as today. `finishPairing()` writes `winner` alongside `endedAt`,
`scoreA`, `scoreB` — no other change to that method.

Client: `CourtPanel`'s active-court template swaps the single "Finish
match" button for two, labeled with the actual team names rather than
"Team A/B":

```html
<button (click)="finish('A')">{{ aNames[0] }} & {{ aNames[1] }} won</button>
<button (click)="finish('B')">{{ bNames[0] }} & {{ bNames[1] }} won</button>
```

Score inputs are unchanged in position/behavior — still optional,
still read from the same `scoreA`/`scoreB` signals. Clicking a winner
button *is* the finish action: it sends whatever score values are
currently entered (possibly both null) plus the winner, in one call.
`LiveSessionService.finishMatch` gains a `winner: 'A' | 'B'` parameter
threaded straight into the POST body.

### 3. Player stats — aggregated in JS from decoded pairings, not SQL

New endpoint:

```
GET /sessions/:code/stats?scope=session|all   (default: session)
```

`SessionsService.getStats(code, scope)`:
- `scope=session`: pairings where `sessionId = code`.
- `scope=all`: resolve the session's `groupId`, then pairings across
  every session with that `groupId` — ended sessions included, since
  `endSession` only stamps `Session.endedAt` and never deletes rows.
- Filter to `endedAt not null` (finished matches only).
- For each pairing, decode `teamA`/`teamB` (same `JSON.parse` pattern
  used everywhere else in this service — there's no relational
  player↔pairing link, so this can't be pushed into a SQL `GROUP BY`)
  and increment `played` for all 4 playerIds; if `winner` is set,
  increment `won` for the 2 ids on that team.
- Join against `Player` (scoped to the group) for display names.
  Response: `{ playerId, name, played, won }[]`, sorted by `played`
  descending.

Client: new `stats-table` component on the session-dashboard page,
with a "This session" / "All-time" toggle defaulting to "This
session," columns Player / Played / Won.

## Schema change

```prisma
model Pairing {
  id          String    @id @default(cuid())
  sessionId   String
  courtNumber Int
  matchNumber Int
  teamA       String
  teamB       String
  scoreA      Int?
  scoreB      Int?
  winner      String?   // 'A' | 'B', null for pre-migration rows
  confirmedAt DateTime?
  endedAt     DateTime?
  session     Session   @relation(fields: [sessionId], references: [code])
}
```

## API surface

```
POST /sessions/:code/pairings/:pairingId/swap { playerId }
     → { ok: true, pairing: { id, courtNumber, matchNumber, teamA, teamB } }
     → { ok: false, reason: 'no-substitute' }
     409 if pairing already confirmed or ended

POST /sessions/:code/pairings/:pairingId/finish { scoreA?, scoreB?, winner }
     (unchanged route, dto gains required `winner: 'A' | 'B'`)

GET  /sessions/:code/stats?scope=session|all
     → { playerId, name, played, won }[]
```

## Client changes

- `LiveSessionService`: new `swapPlayer(pairingId, playerId): Promise<boolean>`
  (mirrors `proposeMatch`'s boolean-result pattern); `finishMatch`
  gains the `winner` param.
- `CourtPanel`: pending case — tap-to-swap on player names, inline
  "no substitute" hint. Active case — two named winner buttons replace
  "Finish match"; score inputs unchanged.
- New `stats-table` component, session-dashboard page: session/all-time
  toggle (defaults to session), Player/Played/Won columns.

## Testing

- `sessions.service.spec.ts`: swap picks the correct substitute and
  rejects on an already-confirmed/ended pairing or an empty pool;
  finish stores `winner`; stats aggregates correctly for both scopes,
  including a pre-migration row with `winner: null` (counts toward
  `played`, not `won`).
- `court-panel.spec.ts`: tapping a name calls `swapPlayer` with the
  right args; each winner button calls `finish` with the right
  argument.
- Manual dev-server pass on all three features (golden path + the
  no-substitute / empty-stats edge cases), per this project's UI
  testing convention.

## Non-goals

- Backfilling `winner` on existing finished pairings from
  `scoreA`/`scoreB` — ambiguous on ties or missing scores, not worth
  the edge-case handling for historical data.
- Any change to `generateRound`, `propose()`, or the reshuffle button
  — targeted swap is a separate operation, not a reshuffle variant.
- A full scoreboard/leaderboard UI (v2, out of scope) — this spec only
  stores the data (`winner` field, stats endpoint) that a future
  scoreboard would read.
- Un-swapping or swap history/undo.
