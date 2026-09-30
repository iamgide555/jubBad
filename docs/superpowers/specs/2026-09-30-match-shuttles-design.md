# Host feedback D: shuttles per match

## Intent and scope

The host needs to track **which physical shuttles** each game used, rather
than how many shuttles to charge anew for that game. A shuttle numbered 1 can
remain playable and be reused in the next game or on another court; two
games referencing shuttle 1 still account for only one physical shuttle.
Numbers are unique across one session, not per court. The host must be able
to distinguish a finished game with no recorded shuttle use from a legacy
game whose use is unknown.

Keep the optional physical nightly count separate from the distinct
shuttles recorded in games; the host can account for warm-up, loss, and
discrepancies without falsifying game history. Avoid sharing bills that
silently treat missing data as zero. Court identity remains the numeric
`Pairing.courtNumber`, with feedback A's labels used only for display.
Feedback E will use this game's shuttle identities to settle an early
leaver, but D does **not** implement checkout or frozen bills. The venue
display stays unchanged.

E must freeze an early leaver's paid amount even if a shuttle they used
is reused later. Its future design must reconcile subsequent reuse
against the **remaining** players' bill, rather than revising the
leaver's payment or prohibiting reuse. Consequently, the equal
per-shuttle sharing below is D's whole-session rule **before checkout**;
E will need an explicit accounting adjustment for frozen amounts.

## Group opt-in shared with early checkout

Numbered shuttle tracking and E's early checkout are **advanced host
tools**, available together to groups that opt in. Add an owner-editable
`Group.shuttleToolsEnabled` flag, default `false`, with a simple switch in
group settings. Snapshot it as `Session.shuttleToolsEnabled` when creating
each session; changing the group flag affects only **future** sessions.
Older sessions default to false. A session created with the flag true
keeps its tracking, history, corrections, and eventual checkout access
even if the group later switches it off. Switching it back on does not
retroactively convert ordinary sessions or guess their game histories.
Only an owner can change the group switch; the existing owner-mismatch
404 semantics apply.

On ordinary sessions, confirmation, auto-confirm, dashboard, and public
summary retain their pre-D shuttle behavior: no numbered identities, no
shuttle-choice prompt or game log. The optional physical count and
end-of-night bill still work. D's bill completeness guard prevents
copying a shuttle-based bill without required inputs, but does not change
ordinary sessions' equal-per-match `byGames` split. Advanced shuttle
endpoints reject ordinary sessions with an explicit disabled-feature
code; a group flag cannot override a session's snapshot.

This switch gates **D and E only**, not A's court labels, C's pair rules,
or F's per-group level ladder. F will have its own always-available group
editor and use today's fixed level list as the default. Do not make
custom level names depend on the shuttle-tools flag.

## Storage and lifecycle

Add session-owned shuttle identities with an immutable, monotonically
increasing display number, unique within the session (including numbers
later voided as mistakes), and an available/unusable status. A shuttle
remains in historical use even when marked unusable; the host can undo an
accidental retirement. Retiring a shuttle currently assigned to an active
court is refused until the host switches that court away. Opening a new
identity and assigning it to a game are one serialized operation. A wrongly
opened identity can be voided only after it has no game references and is
not current on any active court; its number is never reassigned. Old
sessions start with no numbered identities.

Persist a many-to-many game/shuttle use relation with uniqueness per
pairing/shuttle: returning to the same shuttle within one game is still
one use. On `Pairing`, store an explicit known/unknown log marker and the
last current shuttle identity (nullable). Legacy and ordinary-session
pairings remain **unknown** without a backfill; a confirmed advanced-session
game gets a known log, even if later corrected to the empty set (`0`
shuttles). An active court has at most one
current shuttle, and the same shuttle cannot be current on two active
courts. Switching away releases it for reuse elsewhere without implicitly
marking it unusable. The last identity remains after finish for that court's
next-game suggestion; changing a finished game's log to remove that
identity clears the suggestion.

On advanced sessions, manual confirmation offers **reuse the last available
shuttle on this court**, **open a new numbered shuttle**, or **choose any
other available, idle shuttle in this session**. On a court with no
reusable last shuttle, opening new is the default. The chosen start is
recorded atomically with
confirmation; if a specifically requested identity became unavailable,
refuse the stale choice rather than silently opening another. The existing
60-second auto-confirm cannot prompt: reuse the last available, idle
shuttle on that court, otherwise open a new identity. Both paths use the
session lock, so two courts cannot assign the same current shuttle or
allocate the same next number concurrently. Pending proposals create no
shuttles. Ordinary sessions keep their existing confirmation behavior. On
an advanced active court, the host can open a new shuttle or switch to
another available, idle one; both actions add the identity to the game's
use set without double-recording a repeat visit.

Finish (including "no result") preserves the game log and last identity.
Undo finish keeps its log and restores the active court; if the last
identity is now unusable or current on another active court, restore with
no current shuttle and prompt the host to choose one instead of taking
it from that court or blocking score correction. Undo confirmation clears
the game's log and last identity; a later confirmation makes a fresh
choice. Do not delete or renumber identities that were physically opened
just because a confirmation was undone; a still-available identity can
be chosen again. Those identities remain visible in the session inventory.

Owner-only endpoints cover listing/selecting/opening/retiring/restoring
shuttles, live game switches, and finished-game corrections. They must use
the existing session lock, pairing-in-session lookup, and guarded
`Pairing.revision` writes, plus session membership checks on identities.
Commit each identity/use/revision change together; read a consistent
session/game/use snapshot for bill calculation so an in-flight correction
cannot produce a mixed-version total.
Live edits require a confirmed active game in a live session; finished-game
log edits (including adding an opened identity or clearing all uses) remain
possible after the session ends. Historical corrections may name an
unusable shuttle that really was played; only **current/live selection**
requires it to be available and idle. A correction never rewrites the winner,
timestamps, physical count, or another game's use relation. Finish and undo
continue to use revision guards so a switch and winner tap cannot lose each
other. Reject foreign/voided identities, unavailable live choices, duplicate
live occupancy, pending-game edits, and stale revisions with stable
400/404/409 codes;
session ownership retains its existing 404 behavior.

Group export includes the opt-in flag, session snapshot, numbered
shuttles (including status and voided numbers), and each game's
known/unknown status and uses. Group deletion must remove game/shuttle
join rows before pairings, and identities before sessions; its
dependency-ordered operation list is reused by admin deletion.

## Totals, public reads, and bill inputs

Derive accounting from **confirmed, finished** pairings on every read:
`recordedFinishedShuttles` is the count of **distinct shuttle identities**
referenced by their known logs, not the sum of use-list lengths;
`unknownFinishedMatches` counts legacy unknown logs; `finishedMatches`
counts eligible games. Label the distinct subtotal as partial when any
finished game is unknown. Pending or active games contribute neither a
finished use nor an unknown finished game. If no game is finished and no
physical count is entered, there is no known billable count; do not infer
zero from the empty set. A known empty game log is explicitly zero.

Keep `Session.shuttleCount` as the nullable, manually entered **physical
nightly count**, never a denormalized sum. `setShuttleDetails` still handles
this count and the independent shuttle price after the session ends. Show
both totals distinctly in advanced sessions' public summary and on their
owner-only bill; show the physical-minus-recorded difference only when
every finished game has a known log and at least one game is finished.
Previously opened but
unused identities remain visible in the inventory; they do not enter the
finished-game subtotal. Never fabricate legacy uses or rewrite identity
logs to reconcile a difference.

For an advanced session in a shuttle-billing model (`fair`, or `buffet`
without included shuttles), the effective billable count is the physical
count if set, otherwise the
number of distinct shuttle identities used in finished games, only when
all such games have known logs and at least one is finished. Explicit zero
is valid. When neither is available, flag a missing count. `perGame` and
buffet-with-shuttles-included do not require one to copy a bill. Shuttle
price is required only when shuttles are billed; court fee is required for
`fair`. Return the count source (`physical`, `games`, or `missing`),
distinct subtotal, and unknown-game count to the bill UI; preserve
`session.shuttleCount` as the physical value. An ordinary session instead
uses only its physical count, as before; never infer a game total from
the absence of logs on a session that did not enable tracking.

For advanced sessions, pass each finished game's **distinct shuttle IDs
or unknown marker** into the dependency-free bill engine. The `equal`
shuttle split still divides
the effective shuttle cost equally over participants. For `byGames` with
a complete log and at least one referenced identity, split the effective
total shuttle cost equally among the distinct recorded shuttle identities,
split each identity's share equally among the finished games that used it,
then split each game's share equally among its two or four players. Thus a
shuttle used in two doubles games is paid for **once**, with half its cost
allocated to each game before the four-player split. Use integer-exact
largest-remainder helpers in stable shuttle-number, court and match order;
preserve the existing redistribution of removed players' shares. Scaling
the monetary shares to a different physical count does not change any ID
or claim an extra game use, and the discrepancy stays visible.

If an advanced session has a finished game with an unknown log but a
physical total exists, retain the old equal-per-match `byGames` allocation
for the **whole** session and explain the fallback rather than mixing
guessed uses with
known identities. If every game is known but none references a shuttle
and the physical count supplies a positive cost, also fall back to equal
per match. Neither fallback fills in game history. Price-based models and
walk-in discounts retain their existing rules.

The bill engine currently calculates provisional zero-based rows even while
reporting missing inputs. Keep those values only as internal previews:
the bill response has an explicit completeness/ready-to-copy indicator
derived from its required-input warnings. When the bill is incomplete, the
UI shows the warnings and hides final person/total amounts and disables
copying (including any clipboard fallback). The copy handler checks readiness
again, not just the button state. A legitimate zero count, zero price, or
zero court fee is complete. Missing non-required inputs do not block sharing
the per-game or shuttle-included buffet bill.

## Host and public UI

Before a host manually confirms a pending court, show a small shuttle
choice: reuse that court's last available shuttle, open new, or pick
another available shuttle from the session. Save the choice and
confirmation as one action; the host cannot dismiss it and leave a
half-confirmed pairing. Auto-confirm uses its defined default without
opening a dialog. On the **active** dashboard court, show the current
number and the distinct numbers used this game; put 44px-or-larger,
accessible **Open new**, **Switch to existing**, and **Mark unusable**
controls near the winner actions. A shuttle with no current assignment
after undo can be selected. Switching can also retire the previous
shuttle in the same action; a standalone retire control applies only
to an idle shuttle. Keep finish independent of further logging:
the already saved IDs persist when the host taps a winner or "no result."
Disable controls during a write and refresh from the server on success
or stale failure; show a localized error instead of displaying an
unsaved optimistic change. The active court response already carries
`revision`; extend its client type and response with current/used IDs.

Add one compact chronological **shuttle log** to the public session
summary: one row per confirmed, finished game, keyed by pairing ID,
with A's effective court label, match number, and its numbered shuttle
IDs, explicit none, or unknown. An owner-authorized host can correct a
finished game's IDs after the session ends, including setting no use or
creating a missed new identity. The current summary's `isHost` checks
only login: establish edit access with an owner-guarded editable-log read,
not simply with that signal. Public summary data stays read-only.
Apply the same owner check to the existing physical count/price editor
instead of leaving it visible to a logged-in non-owner; its
label distinguishes it from game tracking. Show the distinct finished
subtotal, unknown-game count, optional physical total, and discrepancy
only when the finished log is complete. On correction, refresh summary
and later bill reads. Leave the per-player history and public venue
display unchanged. Use Thai source strings and English translations.

## Verification targets and boundaries

- Opt-in: an existing/default-off group and ordinary session have no
  per-game shuttle prompts, log, or checkout capability; toggling the
  group on/off affects only new sessions; an advanced session retains
  access after the group switch is off. F's editable default ladder
  remains independent; A and C remain available. Ordinary physical
  count and billing remain usable. Creation retries return their
  original session and snapshot, not a new flag value.
- Migration and API: old unknown games versus new known-empty games;
  session-wide sequential numbering; manual choice and auto-confirm
  default; simultaneous confirms on two courts; last-shuttle reuse,
  cross-court selection, repeat use within a game, retirement/restoration
  and erroneous-open void without number reuse. Reject selecting an
  identity current on another active court, selecting a retired/foreign
  one for live play, unconfirmed edits, stale revisions, and unauthorized
  reads/writes. Allow a historical correction to name a retired identity.
- Lifecycle: switching while playing, no-result finish, undo finish
  (including last shuttle used elsewhere), undo confirm, re-confirm,
  winner/switch race, finished correction after session end, and physical
  count unchanged by game edits. Cover both independent courts and
  singles/doubles.
- Aggregates: empty session, recorded-empty game, one numbered shuttle
  reused across several finished games, concurrent active games excluded,
  mixed legacy unknown logs, unused opened identity, retired identities
  with historic use, and physical differences both above and below the
  distinct finished subtotal.
- Engine/bill: physical-versus-complete-log precedence, both shuttle
  billing and non-shuttle models, legitimate zeroes, one shuttle shared
  across games with different participants and singles/doubles, exact
  satang rounding across ID/game/player splits, equal mode, legacy and
  no-reference fallback, removed players, and walk-in redistribution.
  Incomplete required inputs cannot produce copyable LINE text. The
  bill read cannot combine old game uses with a new physical count.
- Web: 44px accessible choice/open/switch/retire actions, stale saves,
  owner-only correction, read-only public log, differentiated totals,
  warning/copy guard, and Thai/English localization/build. Court labels
  resolve without changing match identity.
- Export/deletion: include the group/session flag and every shuttle
  identity/use in owner export; delete join rows and identities in FK
  order for both owner and admin group deletion.

Out of scope: E's early checkout and frozen amounts, per-shuttle wear or
time-of-use tracking, automatic estimation of legacy games, tube inventory
or payments, changing pairing/rating behavior, and shuttle controls on
the public venue display.
