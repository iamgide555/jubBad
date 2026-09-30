# Session court labels (host feedback A)

## Intent and scope

Hosts should be able to call players to the **physical hall's courts**, rather
than the app's default 1-based court numbers. A label belongs to one session:
the same group can play at another venue next time. Thai and English hosts can
use short free text such as `7`, `A`, or `โซนหน้า`. A correction should show up
on every current and past match in that session. Do not change pairing,
rotation, undo, court order, or the `courtNumber` used by APIs and history.

The venue display, dashboard, copy-to-LINE text, and public session summary
must agree. Only an authenticated host authorized for the session may edit a
label. Existing sessions keep their numeric names without a backfill.

## Identity and storage

Add nullable `Session.courtLabels` as a JSON-encoded array of `string | null`;
index zero is app court 1. `null` or an absent entry displays the 1-based
number. No labels are required at session creation. A single parser/writer in
`server/src/sessions/court-labels.ts` owns this column; malformed legacy data
reads as unset names, as with `courtFormats`. Read only the slot addressed by
`courtNumber`, never infer the number of courts from array length. Shrinking
`courtCount` does not discard labels; growing restores them.

Keep `Pairing.courtNumber` and all court URLs numeric. Labels are presentation
metadata on the session, not a property of a pairing. There is no snapshot of
the label at match time: the current label resolves every finished match,
including matches on a court later removed from the active count.

For read responses, return the parsed optional-label array as `courtLabels`
on public `GET /sessions/:code` and on the session object returned by the
public summary endpoint. The client uses one effective-label helper:
`courtLabels[courtNumber - 1] ?? String(courtNumber)`. Also return
`editableCourtCount` on `GET /sessions/:code`: the highest of the current
court count, any court number with a pairing, and any court number with a
non-null stored label. This is only for the host's label editor; `courts`
continues to contain exactly the current court count.

## Writes and validation

Add host-only `POST /sessions/:code/courts/:n/label` with `{ "label": "..." }`.
Use the existing session lock and the same authorization path as the other
per-court mutations. The DTO requires a string of at most 30 characters and
rejects line breaks/control characters. Trim the input and normalize it to
Unicode NFC; empty or whitespace-only input clears the override. The write
changes only one array slot, preserving other courts' labels even when two
devices edit different courts. It is allowed for idle, pending, active, and
ended sessions, since it does not change a match.

The target `n` must be an integer from 1 through `editableCourtCount` (which
includes courts retired after play or after a label was set). Reject a number
outside that range with the existing `INVALID_COURT_NUMBER` response. Visible
names must be unique, including numeric defaults, across those same slots.
Compare trimmed NFC names case-insensitively; a collision returns a
`COURT_LABEL_CONFLICT` (409) without writing. A host swapping two names can
use a temporary label. `setCourtCount` must perform the same uniqueness check
before increasing the count, so bringing back a court cannot create a duplicate
default; shrinking preserves the existing busy-court refusal. Both count and
label writes run under the same session lock. Errors are shown in localized
Thai/English copy on the relevant editor or count control, not swallowed.

## Host and public UI

Keep the court heading prominent and add a 44px-or-larger, accessible edit
control next to it. Editing uses a one-line field with save/cancel; its
placeholder shows the default number, and clearing it restores that number.
Allow a host to rename a court mid-match or after the session ends. Reuse one
small label-editor component for current court panels and a compact retired
court list on the ended-session dashboard; that list includes courts above
`courtCount` through `editableCourtCount` so a past match's name remains
correctable after shrinking. On save, use the existing action/refresh path;
retain the entered value and show a localized error on failure.

The venue display uses the effective label for each court line and keeps its
existing 30-second refresh. The dashboard's copy-to-LINE court list uses the
same labels for both idle and playing courts. The summary resolves each
`SessionMatch.courtNumber` against the summary session's labels at render time;
it still retains the number as its stable key. Any court heading, display
line, or shared text wraps the supplied name as text, never HTML. Update
Thai source strings and English XLF entries for the editor and error states.

## Verification targets

- Server helper and API tests: legacy null/malformed values, Unicode and
  whitespace normalization, blank reset, max length and multiline rejection,
  duplicate custom/default names, invalid targets, independent concurrent
  court writes, active and ended edits, shrink/restore, and count-growth
  collisions. Existing pairing rows and lifecycle state must remain unchanged.
- Server read tests: current court count remains independent of label-array
  length; retired courts are editable and their latest labels appear in
  session/summary responses, including after the session ends.
- Web tests: edit/save/cancel and failure messages on a court panel and the
  retired-court editor; venue display, copy-to-LINE text, and summary all show
  the same updated name. Preserve accessible controls and check Thai/English
  localization/build.

Out of scope: group-wide defaults, scheduled court availability, renumbering
pairings, per-match label snapshots, and shuttle tracking (host feedback D).
