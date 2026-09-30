# Host feedback F: group-owned level ladders

## Intent and scope

Different badminton groups grade players with different ordered labels. A host
must be able to define that group's ladder and its starting Elo values without
changing any other group's labels, erasing match results, or silently changing
the Elo already earned by tagged players. The existing BG, N, S, P-, P, P+,
C, B ladder remains the default for every existing and new group until its
host explicitly switches to custom. Level names are host-only, as they are
today; public player cards, session summaries and venue displays stay level-free.

This is a group setting, available to every group, not part of D/E's advanced
tools switch. Editing a ladder is refused while **any** session in that group
is open. Player levels can still be assigned during a session from the
unchanged ladder, as the existing level-mode and rating workflows require.
Finished matches and past pairing decisions are not rewritten by later edits.

## Ladder and rating data

`Group.levelLadder` is a nullable JSON-encoded ordered list of
`{id: string, name: string, startingElo: number}`. IDs are stable within a
custom ladder: a name edit keeps its ID, so the server can distinguish a
rename from removal plus addition even when several levels change in one
save. New IDs are assigned by the server. `null` means the built-in ladder,
including its present 900, 1000, ..., 1600 seeds; a non-null list is custom.
`Group.levelLadderRevision` increments on each successful edit.
No separate level rows or session-level ladder snapshots are needed because
edits cannot occur during a live session. `Player.level` remains a nullable
name. Add `Player.levelSeed` as the numeric rating anchor last applied to
that player; `Player.levelSetAt` remains the time at which it took effect.
For existing records, backfill `levelSeed` from the present built-in level
(or 1200 when untagged) before enabling custom ladders. An untagged player
with a previous `levelSetAt` retains that timestamp and its existing 1200
anchor; a never-tagged player continues to start at 1200. Rating replay for
singles and doubles reads the saved seed and timestamp, **not** today's
name-to-seed lookup. Existing match history and both computed rating tracks
therefore remain unchanged when the group changes its ladder.

A new level assignment or a deliberate edit to a player's level stamps
`levelSetAt` and saves that level's **current** seed; subsequent confirmed
matches move the rating as today. Explicitly clearing one player's level
keeps today's behavior: reset that player's anchor to 1200 at the edit time.
Choosing their already-selected level is a no-op, even if the group's seed
for that name has changed. The host UI must explain that editing a ladder
seed affects only future assignments/changes, not already-tagged players.
`ratingDelta` and other seed-relative displays use the player's saved
anchor, not the group's latest value for their visible label.

The first **replace standard with custom** action is explicit and warns that
all existing player-level labels in that group become unset. In one
transaction it saves the new ladder and clears those labels but **does not**
change any player's `levelSeed`, `levelSetAt`, match history or Elo. The
reverse **reset to standard** action does the same with custom labels and
sets `Group.levelLadder` to `null`. This clearing applies only at a
standard/custom boundary, not to edits within an existing custom ladder.
An unchanged-label custom list still counts as a first switch and clears
the old labels: the host chose a new grading system, and we never guess
whether identical-looking names mean equivalent levels.

Within a custom ladder, renaming an existing ID atomically updates every
assigned player's visible `Player.level` from its previous name to the new
one, even if two names are swapped in the same save; their saved seed and
level-set timestamp do not change. Moving a level
keeps its ID, name and configurable Elo seed together; the full submitted
ladder must have strictly increasing seeds after the move. Editing a seed
never retroactively reanchors assigned players. Omitting an existing ID
removes that level, but is refused if any player is assigned to it; the host
must first reassign or clear those players individually. Adding a level
never assigns anyone automatically. Do not map removed levels to a neighbor.

For a new custom ladder, offer centered 100-point spacing around 1200:
one level starts at 1200, three start at 1100/1200/1300, and even-length
ladders use 50-point offsets so adjacent gaps remain 100. The host can
override each proposed seed. This suggestion does not alter the built-in
ladder or rewrite an existing player's seed.

## Validation, consistency and access

Accept 1–16 ordered custom levels, with no duplicate or foreign persisted
IDs in an edit. Names are trimmed, nonempty, at most
16 Unicode code points, and unique after case folding; reject control
characters. They may use Thai or Latin script. Each starting Elo is a
non-negative integer, strictly larger than the preceding level's seed;
reject duplicates, fractional numbers, malformed JSON, and invalid order
with actionable 400 errors. Do not turn malformed stored ladder data into
the built-in default or silently turn a nonempty, unrecognized assigned
level into `null`: surface an explicit data-integrity error instead.
An explicit `null` assignment remains valid.

Provide owner-only `GET /groups/:code/levels` returning the effective list,
standard/custom mode, assigned-player counts and revision, and
`PUT /groups/:code/levels` with
`{action: 'customize'|'edit'|'reset', expectedRevision, levels?}`. Only
`edit` accepts existing custom IDs; `customize` creates a new list; `reset`
removes it. Use the existing ownership guard (mismatched owner gets 404;
admin access follows existing policy). Saving checks that **no** group
session has `endedAt = null`, including an unstarted session. This check,
the revision increment, ladder write and any player-label updates are
atomic. Session creation and every group-level assignment writer
participate in the same group-scoped serialization as ladder saves, so
a session or newly tagged player cannot appear between the guard and
commit. A stale `expectedRevision` returns a specific conflict code
without modifying data; the UI reloads and lets the host retry
deliberately. Other groups are unaffected.

Level-bearing player and session writes also carry the ladder revision
that the host saw when selecting the label. Reject a stale revision before
writing anything, even if the same name exists in the replacement ladder:
clearing old labels at a standard/custom boundary must not be undone by an
old browser tab that submits an identical-looking name afterward. A
request without a level choice can still create a session; when a level
choice is present, its revision is required. A one-field level clear uses
the current revision too. Validate membership and seed against that same
revision under the group lock (and inside the existing session-creation
transaction for roster reviews).

The owner-only group export includes the effective ladder, its mode,
each player's current level, saved seed and level-set time. Group deletion
requires no additional child table because the new data lives on existing
group/player rows. Never add ladder details to public `GET /groups/:code`,
the public player list/profile, session summary or display. The web reads
the protected ladder separately and never trusts a client-supplied seed
when assigning a player.

## Engine, API and host UI integration

Keep pure level helpers in `engines/levels.ts`. Pass the group's ordered
ladder explicitly to level validation, indexing, the ±1 band and carry
eligibility; never use process-global mutable levels. All pairing entry
points that evaluate level-mode courts, including per-court custom-mode
levels, receive that same ordered ladder. Preserve the existing wait-only
level queue, solo/multiple newcomer carry rules, unknown-level behavior,
partner/opponent history, and court-independent rotation. An absent group
setting passes the built-in ladder and preserves existing outcomes.
Elo replay uses `Player.levelSeed`/`levelSetAt`; assigning a new level uses
its current group seed on both independent rating tracks.

Replace fixed `@IsIn(LEVELS)` DTO checks with group-context validation
at **every** write surface: roster-review session creation, group player
edit and one-field level edit, dashboard player panel, and new walk-ins.
Unknown names get a clear 400 before writing any player/session data.
`loadPlayerLevels`, carry evaluation, rating loading and host-only
session-level reads use the owning group's ladder consistently; never
return an invalid index such as `-1` to the pairing engine. The LINE
parser currently does not extract level suffixes from roster names, so
paste parsing and fuzzy matching do not need new matching behavior; the
review UI presents the configured level picker for new assignments.

Add the level editor to the group's owner-facing settings and link it
from roster management. Roster review, walk-in dialog, roster page and
dashboard player panel all receive the same ordered list; roster sorting
uses that list instead of importing fixed `LEVELS`. Built-in levels keep
their existing Thai/English descriptions; custom names display as given
without fabricated definitions. The settings UI shows seed numbers and
the saved-anchor caveat, confirms standard/custom transitions with the
number of labels to be cleared, explains blocked removal or active-session
edits, and preserves one-handed 44px controls and Thai-first/English text.
No level data is sent to the public venue display.

## Verification and boundaries

Engine tests cover unchanged built-in order/seeds, three-level centered
defaults, Unicode and duplicate validation, strictly increasing custom
seeds, dynamic ±1 bands and both carry-game shapes; existing level and
pairing-quality suites must still pass. Server tests cover migration of
legacy anchors, no Elo/rating drift on transitions/renames/reorders/seed
edits, future assignment reseeding, both rating tracks, a one-level ladder,
in-use removal refusal, live-session edit refusal including a racing
session creation/player assignment, stale edits, all level-write surfaces,
owner mismatch and absence from public responses, and truthful export.
Web tests cover the editor and reset warning, custom pickers on every
host surface, level sorting, blocked saves, and bilingual labels.

Out of scope: retroactively changing confirmed matches or past group
pairings, automatic conversion of old grades to new grades, deriving
levels from pasted LINE names, player accounts, configurable Elo match
K-factor, and enabling live-session ladder edits.
