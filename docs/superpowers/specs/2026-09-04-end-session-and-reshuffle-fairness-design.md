# End Session + Reshuffle Fairness Design

## Goal

Two independent, small features requested together after manual testing:

1. **End session** — no way currently to mark a session as finished; it
   just stops being visited. Hosts want an explicit end state.
2. **Reshuffle fairness** — reported directly: "reshuffle it still
   match 2 same player even click it alot of times already." Root
   cause found: with exactly 4 players available (the common case),
   there are only 3 possible team-splits, and until anyone's actually
   played, the pairing engine scores all 3 equally (no repeat-partner
   history yet to penalize) — so reshuffle picks among them roughly
   randomly and can trivially repeat what it just showed.

Neither touches the other's code — covered together here because
they were raised together, not because they're related.

## Decisions

### 1. End session — block while any court is active/pending

`POST /sessions/:code/end` rejects (409, clear message) if any
`Pairing` row for the session has `endedAt: null` — that condition
alone identifies both `pending` (`confirmedAt` null) and `active`
(`confirmedAt` set) courts, since only a fully-finished match has
`endedAt` set. This keeps match history clean — no orphaned
score-less entries — at the cost of the host having to wrap up before
ending. No "resume" action — ending is one-way for v1; the group's
past sessions stay reachable through the group entry's existing
"resume last session" pointer regardless, since that only ever
targets the *most recent* session, not whichever one the host most
wants to revisit.

### 2. Reshuffle — exclude only the immediately-previous split, via a scoring penalty

`generateRound` gets a new optional parameter,
`avoidSplit?: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }`.
Inside its existing 200-trial search, a candidate whose team grouping
exactly matches `avoidSplit` (same 4 players paired the same way,
regardless of which side is labeled `teamA`/`teamB`) gets a large
fixed penalty added to its score before comparing against the running
best — steering the search away without a separate exclusion/retry
loop, and composing naturally with the existing repeat-partner/
opponent weighting rather than replacing it.

`SessionsService.propose()` passes the current pending pairing's
`teamA`/`teamB` as `avoidSplit` only when reshuffling (an
`existingPending` row is found); a fresh `propose` on an idle court
has nothing to avoid. With ≥4 available players there are always ≥3
distinct splits, so the search can always steer toward a real
alternative — this can never leave `generateRound` unable to produce
a result.

No client change needed — `CourtPanel.startOrReshuffle()` already
calls the same `proposeMatch(courtNumber)` for both a fresh propose
and a reshuffle; the server tells the two apart by whether a pending
`Pairing` row already exists for that court, entirely transparent to
the client.

## Schema change

`Session` gains `endedAt DateTime?` (nullable, matches `Pairing.endedAt`'s
existing naming convention):

```prisma
model Session {
  code          String          @id
  groupId       String
  date          String?
  venue         String?
  courtCount    Int?
  rawImportText String
  createdAt     DateTime        @default(now())
  endedAt       DateTime?
  group         Group           @relation(fields: [groupId], references: [code])
  roster        SessionRoster[]
  waitlist      Waitlist[]
  pairings      Pairing[]
}
```

## API surface

```
POST  /sessions/:code/end
      sets Session.endedAt = now()
      409 if any Pairing row for this session has endedAt: null
      (i.e. any court still pending or active)
      → { code, endedAt }

GET   /sessions/:code
      response gains `endedAt: string | null` at the top level
      (alongside the existing code/groupCode/date/venue/courtCount/
      rosterPlayerIds/waitlistPlayerIds/courts fields — unchanged
      otherwise)
```

## Client changes

- `LiveSessionService.endSession(): Promise<{ ok: true } | { ok: false; error: string }>` —
  POSTs to `/sessions/:code/end`, reloads the session resource on
  success. On a 409, resolves `{ ok: false, error: <server message> }`
  rather than throwing — mirrors `proposeMatch`'s existing
  boolean-result pattern, and gives `SessionDashboard` something to
  show inline (same minimal-error-handling stance already used for
  `pasteError` — a failure here would otherwise leave the host with
  zero feedback about why the button didn't work).
- `SessionDashboard`: "End session" button, calls `endSession()`,
  shows the returned error inline on failure. Hidden once
  `session()?.endedAt` is already set.
- `CourtPanel`: reads `liveSession.sessionResource.value()?.endedAt`
  directly (already has `liveSession` injected) rather than a new
  `@Input` threaded through `SessionDashboard`'s template — when set,
  renders a plain "Session ended" state instead of the
  idle/pending/active action controls. (In practice a `CourtPanel`
  never renders anything but idle courts once a session has ended,
  since ending is blocked while any court is pending/active — this
  still exists for a host revisiting an old, already-ended session's
  dashboard.)
- `SessionDisplay`: shows a plain "Session ended" state instead of the
  live court grid and waiting queue when `session()?.endedAt` is set.

## Non-goals

- Reversing/un-ending a session.
- Any change to `CourtPanel.startOrReshuffle()` or other client-side
  reshuffle call sites — the fairness fix is entirely server-side.
- Cycling through *all* distinct splits before repeating (the
  alternative option from the design discussion) — excluding just the
  immediately-previous split is enough to fix the reported problem
  and is simpler to reason about and test.
