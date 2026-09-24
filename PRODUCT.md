# Product

<!-- impeccable:product-schema 1 -->

This is the compact product record the impeccable design skill reads before
visual work. For the durable *why* behind engine/session behavior — fuzzy
match, pairing, history, auto-confirm, undo, etc. — read `docs/overview.md`
instead; that file is the source of truth and this one should not drift from
it.

## Platform

web

## Users

Badminton club hosts/organizers — not the players. They run a live session
(a "ก๊วน") for their club, typically alone, on their own phone, courtside.
The audience is multiple clubs and hosts, not just one group — the tool is
meant to work as a real product for anyone organizing badminton nights, not
a personal script for one person.

## Product Purpose

Fairly rotates a roster of players across N courts, round after round, for
an entire evening. Proposes who plays each round, tracks games played per
person, avoids repeat partners/opponents (weighted across the group's whole
history) and repeat exact groups of four, and lets the host confirm, finish,
swap, or undo a match. Success looks like nobody feeling stuck playing the
same people or unfairly benched, and the host spending the night watching
the courts instead of doing rotation math by hand.

## Positioning

An automated fairness-and-variety matchmaking engine — games-played and
waiting-time balancing, partner/opponent history weighting, and recent-group
-repeat avoidance — doing the job a host would otherwise do on paper, a
whiteboard, or by eyeballing a chat group. Self-hosted, per-user host login
(email + password), no per-player accounts.

## Operating Context

- The session dashboard is used live, courtside, on a phone, between and
  during matches — the surface that carries almost all real usage.
- A second, unguarded route is displayed on a venue TV or projector so
  players can see court assignments from across the room; it must stay
  legible at a distance, not just on a handheld screen.
- A session's roster is set up by pasting names copied from a LINE chat
  message, once per session (weekly, typically) — or, with nothing to
  paste, built by hand on the same screen.
- Two more public, read-only surfaces get shared as links after the fact: a
  session recap, and a per-player stat card.
- The UI is Thai-primary (`th` source locale) with an English build also
  produced.

## Capabilities and Constraints

- Three routes are admin-guarded (landing, group entry, session dashboard);
  three are public and read-only (player profile, session display, session
  summary) — this access split is fixed.
- Matchmaking/scoring logic, API behavior, and the data model are engine and
  server concerns, not visual ones — see `docs/overview.md`, not this file,
  for that reasoning.
- Every text style must render both Thai and Latin scripts; no typeface
  choice may drop Thai coverage.

## Brand Commitments

None binding. "JubBad" is the current name, appearing once, on the login
screen. The existing app icon (a flat badminton-court graphic) and color
palette are not locked — confirmed open to full replacement.

## Evidence on Hand

No real photography, testimonials, or user quotes exist for this product.
New visual work must not fabricate "real" game photography or player
likenesses presented as genuine; any illustrative material is authored and
labeled as synthetic rather than passed off as real evidence.

## Product Principles

1. The dashboard is the product — courtside, one-handed, built to be read
   and acted on fast, between rallies.
2. Fairness is the whole pitch — who's up next and who's owed a game should
   be legible at a glance, not buried in a table.
3. One visual world, two reading distances — the host's handheld tool and
   the spectator's wall display share a system but serve very different
   viewing distances and never blur into each other's job.
4. No accounts, no ceremony beyond host login — a self-hosted tool with a
   per-user host login should not gain friction a real product with
   player-facing sign-ups would need.
5. Bilingual by default — every type, spacing, and layout decision must hold
   in both Thai and English.

## Accessibility & Inclusion

No specific standard has been established for this product. Preserve the
existing 44px tap-target sizing and contrast suited to gym/outdoor lighting
conditions.
