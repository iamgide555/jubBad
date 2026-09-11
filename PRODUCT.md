# Product

<!-- impeccable:product-schema 1 -->

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
whiteboard, or by eyeballing a chat group. Self-hosted, single admin-token
login, no per-user accounts.

## Operating Context

- The session dashboard is used live, courtside, on a phone, between and
  during matches — the surface that carries almost all real usage.
- A second, unguarded route is displayed on a venue TV or projector so
  players can see court assignments from across the room; it must stay
  legible at a distance, not just on a handheld screen.
- A club's roster is set up by pasting names copied from a LINE chat
  message; this happens once per club, not every session.
- Two more public, read-only surfaces get shared as links after the fact: a
  session recap, and a per-player stat card.
- The UI is Thai-primary (`th` source locale) with an English build also
  produced.

## Capabilities and Constraints

- Three routes are admin-guarded (landing, group entry, session dashboard);
  three are public and read-only (player profile, session display, session
  summary) — this access split is fixed and out of scope for this redesign.
- All matchmaking/scoring logic, API behavior, and data model are out of
  scope for this work — it is a visual-layer redesign only.
- Every text style must render both Thai and Latin scripts; no typeface
  choice may drop Thai coverage.

## Brand Commitments

None binding. "JubBad" is the current name, appearing once, on the login
screen. The existing app icon (a flat badminton-court graphic) and color
palette are not locked — confirmed open to full replacement.

## Evidence on Hand

No real photography, testimonials, or user quotes exist for this product.
The redesign must not fabricate "real" game photography or player likenesses
presented as genuine; any illustrative material is authored and labeled as
synthetic rather than passed off as real evidence.

## Product Principles

1. The dashboard is the product — courtside, one-handed, built to be read
   and acted on fast, between rallies.
2. Fairness is the whole pitch — who's up next and who's owed a game should
   be legible at a glance, not buried in a table.
3. One visual world, two reading distances — the host's handheld tool and
   the spectator's wall display share a system but serve very different
   viewing distances and never blur into each other's job.
4. No accounts, no ceremony — a self-hosted, single-login tool should not
   gain friction a real product with sign-ups would need.
5. Bilingual by default — every type, spacing, and layout decision must hold
   in both Thai and English.

## Accessibility & Inclusion

No specific standard has been established for this product. Preserve the
existing 44px tap-target sizing and contrast suited to gym/outdoor lighting
conditions.
