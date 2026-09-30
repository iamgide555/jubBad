# Host feedback C: pair rules

## Intent and product contract

A host needs to keep particular players together or apart without remembering
to repair every suggested match. Three group-level rules are available:
`must-pair` (คู่กัน: both play as doubles teammates or both sit),
`never-teammates` (ห้ามอยู่ด้วยกัน: opponents are allowed), and
`never-same-court` (ห้ามเล่นด้วยกัน: neither opponents nor teammates).
When both players are available, enabled rules are **hard constraints above
every mode**: variety, balanced, level, and custom. The selected mode chooses
the fairest option *among legal options*; the engine never silently relaxes a
rule. Hosts may disable a particular group rule for one session, but manual
seating cannot bypass an enabled rule. No group or session rules are public.

If no legal match can be found for a requested court, leave it unproposed and
tell the host which relevant rules/players need attention, without claiming a
single rule alone is necessarily the cause. Fill other feasible idle courts
independently. An exhausted bounded search is a distinct, explicit
search-limit error, **not** a proof that no legal arrangement exists.

## Persistence and editing

Store `PlayerRule { id, groupId, playerAId, playerBId, kind, createdAt }`
with the two IDs sorted, unique `(groupId, playerAId, playerBId)`. Both players
must belong to that group; self-links and conflicting kinds for the same pair
are rejected. A player can have at most one `must-pair` link; negative rules
can involve several different other players. Deleting a rule leaves finished
match history alone. Editing an existing kind is an explicit replace,
validated as one atomic operation. Rule changes take effect in ongoing
sessions for actions started after the edit succeeds. Serialize rule writes
per group and recheck the one-must-pair-per-player invariant inside the write,
so two simultaneous requests cannot each create a different required partner
for the same player. A rejected second write does not change the first.

`Session.disabledRuleIds` is a JSON-encoded list of group rule IDs, initially
empty. Session hosts can switch each rule off and on without changing the
group default or other sessions. Missing/null legacy data means none disabled;
a malformed non-null list is an invalid session state, not permission to
silently ignore constraints. Deleted rule IDs in that list are inert. Check
group membership of the rule when changing its session toggle. A rule is
applicable only when both players are active on this session's roster; if one
is absent/resting, the other may play alone or on a singles court. The link
still exists for carry accounting below.

Expose CRUD through owner-guarded group endpoints and enabled/disabled state
through owner-guarded session endpoints, under the existing group/session
ownership semantics (an owner mismatch is 404). Persistent editing lives on
the host's player-roster screen; session toggles and actionable rule-conflict
messages live on the host dashboard. Offer concise bilingual labels, player
names, and one-handed 44px-or-larger controls. Do not include rules in public
session, display, player-profile, or summary responses. A group edit saved
mid-session applies to subsequent pairing/confirmation operations, not by
interrupting an operation already in progress.

Include the group's rules, each session's disabled IDs, and the confirmed
pairings' carry outcomes in the owner-only group JSON export. The repository's
group hard-delete builds its own dependency-ordered operations rather than
using DB cascades; delete rules before their players/group in that operation
list, including the admin's multi-group deletion path that reuses it.

## Constraint-aware selection and search

The engine gets the currently enabled, applicable rules from the server;
invalid IDs, contradictory data, or cross-group links fail loudly with
`INVALID_SESSION_STATE`. With no applicable rules the old engine path and its
seeded outcomes remain unchanged. Rules are not partner/opponent history and
never alter confirmed-history counts.

A `must-pair` duo is a two-seat unit during sit-out and court selection.
Either both sit, or both occupy one doubles team; it never straddles courts
and cannot enter singles while both are active. For games-first modes use the
less deserving member (more effective games, then shorter wait) to rank that
unit; level mode uses the shorter-waiting member because its queue ignores
games. The unit can be skipped for a court it cannot fit and considered for
a later doubles court. Other roster members stay individual. Select legal
available players, keeping the requested court first on `propose` and
maximizing seats filled on `fillIdleCourts`, then optimize the selected mode's
existing fairness objective; do not starve a feasible court solely because
an earlier court could not accommodate a unit.

Reject a court group containing a `never-same-court` pair. Among remaining
groups, reject splits with `never-teammates` partners or `must-pair` players
on opposite teams. Exact enumeration for at most eight playing players
enumerates only legal candidates. For larger rosters, build at least one
legal seed and perform legal unit-aware local moves; a bounded feasibility
search distinguishes a proven lack of a valid assignment from a search limit.
Limit the larger-roster feasibility search to 100,000 explored partial
assignments per proposal; if that budget is exhausted without proving a
solution or impossibility, return `PAIR_RULE_SEARCH_LIMIT` with no pairing
written. Use the same bound on each independently planned fill-all mode
group, reporting any already filled courts and the inconclusive group
explicitly rather than returning an unqualified success. Never treat
exhausted random restarts as proof of infeasibility. Preserve
mode scoring (including level's soft band), confirmed history, and per-court
singles/doubles formats **after** applying the hard filters. If a hard rule
leaves only one legal split, reshuffle may return it again rather than
reproducing an illegal split; previously shown split exclusions yield to
pair rules only when no unseen legal split remains.

The level carry builder must also honor units and both negative rules. For a
linked far-below newcomer with an unsuitable required partner, it can skip a
forced carry and offer normal legal matches; the newcomer remains eligible
for a genuine carry later. When a required partner is tagged strictly above
that newcomer, partnering them counts as a completed carry even if they are
not the highest-level available player. A linked newcomer with an unavailable
required partner can instead partner another stronger player for a carry.
Existing behavior for **unlinked** newcomers, including a multi-newcomer
no-pro game, is unchanged.

## Pending matches, overrides and carry state

Active matches already in progress when a rule changes finish as they stood.
New rules can leave an existing pending proposal invalid on screen so the
host can repair it; manual confirmation and auto-confirm share one rule-aware
blocker, and neither may start an invalid match. Reshuffle, substitution,
cross-court trade, manual seats, and custom auto-pair must not save a completed
new violation. Temporarily incomplete custom drafts remain editable; once
full, they must meet every enabled rule. Changing a rule or session toggle
does not rewrite a match's teams or its match number. Undo of confirmation
returns a pending match subject to the *current* rules.

The existing carry-eligibility calculation treats any confirmed game after
tagging as completion. Preserve that behavior for unlinked newcomers and
legacy pairings. On each confirmation (manual or automatic), persist an
outcome `[{ playerId, partnerId: string | null }]` on `Pairing` for **every
tagged player with an enabled `must-pair` link**, even if they are not
far-below at that instant. `partnerId` is the actual teammate only when the
player is far-below *at confirmation* and that teammate is tagged strictly
higher; otherwise it is `null` and the carry opportunity is **not**
completed. Recording the null decision even before someone becomes far-below
prevents a later arrival/rest change from reinterpreting that earlier game
as a completed carry. This also covers games while the required partner
rests. A later level change cannot rewrite the historical decision;
`levelSetAt` still limits eligibility to games since the current tag. A
session-disabled link does not create a new linked outcome; previously
deferred games remain deferred, while subsequent unlinked games use the
existing first-game rule. Adding a link later does not retroactively change
outcomes of games confirmed before it existed. Count only the suitable
teammate, not opponents, as the linked game's carry partner. Clear the
outcome on undo of confirmation; undo of a finish leaves it attached to the
still confirmed match. Ratings and partner/opponent history remain unchanged.

## Errors, tests and boundaries

Use stable server codes for invalid rule data, a blocked proposal, a
rule-violating confirm/edit, and an inconclusive search. Show names and
rules on host-only screens; never turn a blocked proposal into the existing
"not enough players" result or an apparently successful empty response.
The auto-confirm sweep leaves blocked proposals pending and continues to
process unrelated courts.

Test no-rule regression against existing seeded engine cases; legal and
infeasible four-player examples; mixed singles/doubles and sit-out units;
multiple courts with partial legal fills; exact and larger-roster search
without false "impossible" outcomes; every mode's objective after filtering;
no duplicate player, illegal split, or leaked public rule; group ownership,
cross-group IDs, concurrent conflicting rule edits, and per-session
disable/enable. Exercise
pending rule changes, partial custom drafts, manual swaps, auto-pair,
auto-confirm, undo, link deletion, group export/deletion, and two tabs changing
session toggles.
For linked carry, test unsuitable partner, higher-level partner, unavailable
partner with a different stronger teammate, level retag, disabling the rule,
an arrival/rest change that makes a tagged player far-below only after an
earlier non-carry game, and confirmation undo. Keep the engine dependency-free and recheck its
existing quality/performance suite as well as server and web tests.

Out of scope: a soft-rule mode, manual override without disabling, group
rules inherited across different groups, relationship history in the
partner/opponent counts, and changing the behavior of unlinked carry games.
