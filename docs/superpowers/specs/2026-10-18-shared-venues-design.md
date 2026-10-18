# Shared venue list with search — design

Status: approved by owner 2026-10-18; built on branch `feat/shared-venues` (not yet merged or deployed; the real backfill has not been run).

## Intent and why

The roster-entry form has a free-text venue field (สนาม). It is stored on
`Session.venue` and shown on dashboards, bill text and the display page, but
"สนาม A" and "สนามเอ" are different venues and nothing can search or reuse them.

Make the venue a shared list across all hosts. The field becomes a search box:
as more hosts use the app, more venues exist, and a host picks theirs instead
of retyping it.

## Dropped, on purpose

The first draft also stored session hours, a rate per court-hour and
suggested court fees from past sessions. The owner dropped all of it: hosts add
courts mid-session, so a per-court-hour rate is hard to define and track. The
host keeps typing the court fee by hand in bill settings, as today. If this
comes back, it is a new request.

## Goals

1. The venue input searches a **shared venue list** as the host types.
2. A name not in the list becomes a new venue when the session is created.
3. Picking a venue is still optional, and the start flow gets no extra steps.

## Non-goals

- Addresses, maps, photos, opening hours, booking, reviews.
- Any price, hours or court-fee data tied to a venue.
- An admin screen to merge or rename venues (merge by hand in the DB for now).
- Backfilling other hosts' sessions.

## Anti-goals

- **Similar names never auto-merge.** A similar name is a suggestion the host
  taps (same rule as players, see `docs/overview.md`). A duplicate venue is
  recoverable; a wrong merge is not.
- No extra ceremony in the start flow.
- Public pages (display, dashboard) keep showing just the venue name.

## Behaviour

- **Search:** typing in the venue input on `/g/:groupCode/start` lists matching
  venues from the shared list. Tap one to use it, or keep what was typed.
- **Suggestions:** names similar to the typed text are listed as suggestions
  (reuse the ideas in `engines/fuzzy-match.ts`). Never auto-selected.
- **Parsed venue:** a venue pulled from the pasted LINE message pre-fills the
  field as today, then goes through the same search.
- **Exact match:** if the typed name equals an existing venue's normalized name,
  the session links to that venue automatically (same rule as exact player
  matches). Nothing similar-but-not-equal is linked without a tap.
- **New venue:** created when the session is created, by any logged-in host.
- **Existing sessions:** keep their venue text and keep working.
- **Backfill of the owner's own history (owner decision):** a one-off script,
  not part of the schema migration, creates venues from the venue text on
  sessions in groups owned by one named host (the owner), and links those
  sessions. Other hosts' sessions are left untouched. The schema migration
  itself backfills nothing. For the owner's groups **Bad@Mama** and **วันพฤหัส**,
  every session is set to **Mama Badminton** and **KIP Complex** respectively,
  overwriting any venue text already there. The owner's other groups are left
  exactly as they are; their venues join the list when their next session is
  created.

## Data (shapes left to the builder)

- New `Venue` table: id, display name, normalized name, created at.
- `Session` gets a nullable link to `Venue`. `Session.venue` text stays as the
  display name so every existing read path keeps working.
- One read endpoint for venue search, for logged-in hosts only.

## Constraints

- NestJS + Prisma + SQLite; needs a migration (check for undeployed migrations
  before rebuilding, per project notes).
- Thai primary, English second locale; both strings for every new label.
- Dashboard used one-handed courtside; 44px tap targets.
- Update `docs/overview.md` when done.

## My calls (not confirmed by the owner)

- **Backfill script details:** takes the owner's email as an argument (nothing
  hardcoded), dedupes by exact normalized name only, supports a dry run that
  prints what it would create, and is safe to run twice.
- **No moderation** beyond requiring a logged-in host.
- **Venue is set at roster entry only.** If the app already lets a host edit a
  session's venue later, that edit goes through the same search.

## Left to the builder

- Normalization rule (case, spaces, Thai spelling variants) and fuzzy-match tuning.
- How the parser handles multi-word venue names (it keeps only the first word
  after the `@` tag today), so the form field must stay editable.
- Search endpoint shape, result limit, and tests.
