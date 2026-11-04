# BiewBad comparison (observed 2026-10-28)

A competitor a host's friend pointed out: `biewbad.com`, a badminton ก๊วน
site. This is a record of what its **public pages** show next to what JubBad
does, so the comparison is not redone from memory. It is a record, not a
plan: nothing here is scheduled, and the roadmap rule still applies (a
competitor having something is not by itself a reason to build it; see
`2026-09-21-feature-review-and-roadmap.md`).

## What was and was not seen

Seen (read-only, public): the main session page, the all-matches page, the
rankings page, one player profile, the payment panel. Nothing was submitted;
"บันทึกผล" (record result) and "ส่งสลิป" (send slip) were not opened, and the
per-row "สรุปประจำวัน" (daily summary) button showed nothing when clicked.

**Not seen: how a host sets up a session, pairs players or enters results.**
That side is presumably behind a login and was deliberately not touched. So
this comparison covers what players see, and says nothing about the
matchmaking itself, which is the part that matters most for a pairing app.

## What BiewBad shows

- **Main page:** session header (group, venue, date, season, host, start
  time, court fee, shuttle fee), a "player of the night" hero card, counts
  (registered, arrived, playing, resting, matches, shuttles), and a roster
  table with photo, level, rating and today's change, W/D/L, matches,
  shuttles, cost, wait time, a QR button and a "send slip" button per row.
- **All-matches page:** one card per match with the result, each side's team
  skill total, and each player's rating before/after and change.
- **Rankings page:** a public season leaderboard, 3 points for a win, 2 for a
  draw, 1 for a loss.
- **Player profile:** season picker; league rank, points, win-loss, rating,
  rating rank; level, gender, handedness, game win rate, W/D/L; a rating
  line chart per tournament night (average, high and low, 7000 baseline); a
  most-played-with partner list and a most-faced opponent list, each
  sortable by games or by win rate with games, W/D/L and win rate per row;
  paginated match history with rating before/after and the change per match.
  The five profile tabs are scroll anchors on one page.
- **Ratings move in fixed steps** (every change seen was a multiple of 25),
  not smoothly. The rule was not worked out from what is on screen.
- **Draws are common** (44 of 120 for the profile checked). Their client
  code shows a draw is a stored result of "withdrawn" (see "What their front
  end shows"), so this is people withdrawing or the host marking no winner,
  not tied games.
- **Payment:** one static PromptPay QR for the host's account in the header,
  plus a QR button per roster row. Whether the per-row QR embeds the
  player's amount was not verified. No payment status is shown.
- **Every player has a photo.**

## What their front end shows

Read from the two first-party scripts the player page loads (`player.js`,
`match-card.js`, about 43 KB together), captured passively through REA from an
isolated throwaway Chrome. Nothing was executed against their server: no
endpoint was called, and the score-saving call was read, never sent. This is
behaviour only; no code is copied here.

- **Stack:** server-rendered PHP pages (a comment names a `.php` template),
  jQuery 3.6, Bootstrap 5, Chart.js 2.9.4, no build step. The profile hero and
  its figures are rendered on the server; the rating chart, the partner and
  opponent lists and the match table are filled in by script.
- **Everything is season-scoped.** Every stats call carries a player id and a
  season id; changing season reloads the page.
- **Rating chart:** its data is embedded in the page as JSON with a date, an
  average, a high and a low per point, drawn against a flat 7000 line labelled
  as the starting rating every player begins at. What the high and low are
  taken over is not visible from the client.
- **Partner and opponent lists:** loaded on demand from two stats endpoints,
  each returning one row per person with wins, losses, draws, total matches,
  level title and photo. **The sorting and the win rate are done in the
  browser.** Win rate counts a draw as half a win. A "details" button per
  person opens a modal listing every shared match plus a sentence comparing
  the average skill of that player's teammates (or opponents) to the viewer's,
  expressed as "N levels lower/higher". The match history is paged 20 at a
  time from a third endpoint.
- **One match-card renderer** is shared by the profile and the all-matches
  page. A match row carries: status (competing, waiting to be called, ended,
  completed, cancelled), a created time, a shuttle count per match, each
  player's level points and rating at that time, and a rating gain per side
  (both players on a side move by the same amount). A gain not yet computed
  shows "รอคำนวณ" (pending calculation), so ratings are calculated after the
  match, not at the moment it ends.
- **Level points:** levels are 1000 points apart, and the "คะแนนฝีมือ" shown
  per side is just the average of the two players' level points. The arrows
  on a card are one caret per 1000 points of difference. In the client this is
  display only; whether the server uses it for pairing is unknown.
- **Result model:** a match's result is stored from team one's point of view
  as won, lost or withdrawn; withdrawn is shown as a draw for both sides. The
  result is entered by an admin first. Scores come second, up to three games
  of 0 to 30, and the server checks them against that result and returns an
  error message if they disagree. So a score cannot change who won. The
  dialog offers score entry only for matches that already have a result.
- **Photos:** a path per player, shown from a resized copy, with a default
  avatar when none.
- **Not visible from the client:** how ratings are calculated, how pairs are
  chosen, and whether saving a score needs a login.

## Differences

Public-facing only. "Data" means we already compute or store the inputs.

| Thing | BiewBad | JubBad |
|---|---|---|
| Full partner / opponent lists | Yes, sortable, with W/D/L and win rate | Card shows only a best partner, a most-faced opponent and a partner-variety line (`player-profile.html`). The inputs for a fuller list likely exist (the pairing engine and best-partner line use them), not verified per partner |
| Rating over time | Line chart per night | One current number. Ratings are recomputed from history and never stored, so a per-night line means replaying and recording the rating after each night: inputs exist, it is not free |
| Seasons | Season picker, season-scoped rank | None; history scope is a per-group switch |
| Per-match history on a profile | Paginated, with rating change | Not on the card |
| Public leaderboard | Ranks everyone with points | Participation-only standings by design |
| Player of the night | Hero card | None |
| All-matches feed | Yes | Venue display shows active courts only |
| Player photos | Yes | No photo field. New data, not hidden data (upload, storage, consent) |
| Per-person QR and slip upload | Buttons on every row | Bill is calculated and copied as text |

## Differences that are decisions, not gaps

- **Public ratings and rank.** BiewBad publishes everyone's rating and rank.
  JubBad decided against it: a public ranked skill list puts the weakest
  players in front of the whole chat (`overview.md`, Group dashboard and
  Ratings). Do not read the table above as a to-do list.
- **QR, collecting money, payment tracking.** Delegated to KhunThong; only the
  share calculation is in scope (`overview.md`, product decisions and
  out-of-scope list). An earlier note in the session that a QR would be
  cheap to add was wrong about this and was withdrawn.
- **Scores ignored in ratings, win/loss Elo with K = 16.** Different rating
  model from BiewBad's fixed steps; not compared further because their rule
  is unknown.

## Open questions

- Their pairing, rotation and result-entry flow (unseen).
- What "สรุปประจำวัน" and "ส่งสลิป" do.
- Whether their team skill totals ("คะแนนฝีมือ", the average of two level
  points) are used for pairing or rating on the server. The client only
  displays them.
- What "สรุปประจำวัน" does (it showed nothing when clicked).
- Whether any JubBad host has asked for a partner/opponent list, a rating
  history, or per-match history. None has been recorded. Ask the ตีชิล and
  Bad@Mama hosts before building any of it.
