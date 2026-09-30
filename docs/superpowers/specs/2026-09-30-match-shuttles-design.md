# Host feedback D: shuttles per match

## Intent and scope

The host should count actual shuttlecocks while each court is playing, rather
than reconstructing the night from memory. Each confirmed match has its own
editable count, including singles and games with no winner. A count of zero
means "recorded as none"; an unknown old match is different. The host also
needs a separate physical count for the whole night (including warm-up, lost
shuttles, and other differences), and must not accidentally share a bill that
pretends missing data costs nothing. Court identity remains the numeric
`Pairing.courtNumber`; the labels from feedback A are only for display.

Feedback E will use recorded match counts to settle an early leaver, but this
feature does **not** implement checkout, freeze bills, or change who is billed.
The venue display remains unchanged.

## Storage and lifecycle

Add nullable `Pairing.shuttlesUsed Int?`, without backfilling old pairings.
`null` means unknown, `0` is valid, and writes accept only integers 0–99.
Pending matches have `null`. Both manual confirmation and the auto-confirm
sweep set the count to **1** in the same guarded update that sets
`confirmedAt`; a confirmed match therefore starts with a saved count even if
the host never taps the new control. Do not initialize it on proposal or
reset it on finish. Undo of finish keeps the count on the restored active
match; undo of confirmation clears it along with `confirmedAt`. Reconfirming
starts it at 1 again. The count belongs to the pairing, not to the court
number or to the last value recorded on that court.

Add an owner-only `POST /sessions/:code/pairings/:id/shuttles` accepting
`{ shuttlesUsed: number, expectedRevision: number }`. Use the session lock,
the existing pairing-in-session lookup, and a guarded update that increments
`Pairing.revision`. Require `confirmedAt` to be set. Active matches may be
edited only while the session is live; finished matches may be corrected
after the session ends. Reject edits to pending pairings, deleted/foreign
pairings, out-of-range or fractional values, and stale revisions with stable
400/404/409 codes. An edit never rewrites a winner, timestamps, the physical
count, or another match. Finish and undo still use their existing revision
guards, so a simultaneous winner entry and shuttle tap cannot lose either
write. Ownership uses the same guard as other session mutations.

## Totals, public reads, and bill inputs

Derive shuttle accounting from **confirmed, finished** pairings on every
read: `recordedFinishedShuttles` is the sum of non-null values;
`unknownFinishedMatches` counts null values; `finishedMatches` is the number
of eligible pairings. The subtotal is always labeled as partial when
`unknownFinishedMatches > 0`. Do not mistake an empty finished-match set for
an explicitly recorded zero: when there are no finished matches and no
physical count, there is no known billable count.

Keep `Session.shuttleCount` as the nullable, manually entered **physical
nightly count**, never a denormalized sum. `setShuttleDetails` still handles
this count and the independent shuttle price after the session ends. Show
both totals distinctly in the public summary and on the owner-only bill;
show the physical-minus-recorded difference only when every finished match
has a count and at least one match is finished. Never manufacture counts for
legacy games or change a match's saved count to reconcile a difference.

For a shuttle-billing model (`fair`, or `buffet` without included shuttles),
the effective billable count is the physical count if set, otherwise the
finished-match sum only when complete and nonempty. Zero is a valid explicit
physical or complete game count. When neither is available, flag a missing
count. `perGame` and buffet-with-shuttles-included do not require a count to
copy a bill. Shuttle price is required only when shuttles are billed; court
fee is required for `fair`. Return the count source (`physical`, `games`, or
`missing`), game subtotal and unknown-match count to the bill UI; leave
`session.shuttleCount` recognizable as the physical value.

Pass per-match `shuttlesUsed` into the dependency-free bill engine. The
`equal` shuttle split is unchanged. For `byGames` with a complete game log
and a positive recorded sum, allocate the **effective total shuttle cost**
between finished matches proportionally to their recorded counts, then split
each match share equally among its two or four players. Use the existing
integer-exact largest-remainder helpers (stable match order) and preserve the
existing redistribution of removed players' shares. If any match count is
unknown but the host entered a physical total, retain the old equal-per-match
`byGames` allocation and explain the legacy fallback on the bill. Likewise
use equal-per-match allocation when all recorded counts are zero but a
positive physical total provides cost without usable weights. Neither
fallback fills in unknown match counts. A physical/game discrepancy remains
visible; proportional allocation scales monetary shares to the physical
total but does not alter any recorded match count. Price-based models and
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

On each **active** dashboard court, place a labeled `− / number / +`
shuttle control near the score/winner actions; each tap immediately saves
with the pairing revision already in the live response (expose that
revision and `shuttlesUsed` in the active court's client type), disables
during the request, and refreshes the court from the server. Buttons have
at least 44px targets and accessible Thai/English labels, including
court/match context. Disable `−` at 0 and `+` at 99. Keep finish
independent of the counter: tapping a winner or
"no result" saves the already persisted value without another shuttle field
or blocking on entry. A failed or stale tap keeps an explicit localized
error and reloads the authoritative count; do not display an unconfirmed
optimistic increment as saved.

Add one compact, chronological **shuttle log** to the public session summary:
one entry per confirmed, finished match, keyed by pairing ID, with its
effective court label (from A), match number, and count or "not recorded."
Only an owner-authorized host sees correction steppers on these rows,
including after the session ends: the current summary's `isHost` only checks
whether someone is logged in, so use an owner-guarded read of editable log
rows/revisions to establish edit access rather than treating any logged-in
host as the owner. The public summary stays read-only. The summary's
existing physical count and price
editor remains host-only, relabeled to distinguish the physical total from
game counts. Show the recorded finished subtotal, number of unknown games,
physical total if entered, and a discrepancy only for a complete log. Refresh
the summary on successful correction; reflect corrections in subsequent
bill reads. Keep the per-player history and public venue display unchanged.
Use Thai source strings and English translations.

## Verification targets and boundaries

- Migration and API: old pairing `null`, manual and automatic confirm default,
  active/finished/ended edits, numeric validation, ownership and cross-session
  access, stale revisions, winner/tap race, finish without winner, undo finish,
  undo confirm, and independent courts. No write changes the physical count.
- Aggregates: no finished matches, all-known including zero, mixed unknown and
  recorded legacy matches, correction after end, and physical differences
  both above and below the recorded sum. A pending or active match contributes
  neither count nor unknown finished game.
- Engine/bill: effective-count precedence, both shuttle-billing models and
  both non-shuttle-billing modes, missing required inputs and valid zeroes,
  proportional allocations for 2 vs. 4 shuttles (singles and doubles),
  exact satang totals, equal mode, legacy and all-zero fallback, removed
  players, and walk-in redistribution. An incomplete bill cannot be shared.
- Web: 44px accessible increment/decrement, successful and stale saves,
  host-only post-session correction, read-only public log, differentiated
  totals and discrepancy, provisional-bill warning/copy guard, Thai/English
  build and localization. Existing court labels resolve without changing
  stored match identity.

Out of scope: E's early checkout and frozen amounts, tube inventory
management, guessing old match counts, per-court default carry-forward,
changing pairing/rating rules, and displaying shuttle controls on the public
venue screen.
