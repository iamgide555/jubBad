# Forgotten Session Closure Design

## Goal

- **Close forgotten sessions on demand:** before creating a new session for the same group, the host resumes or explicitly closes every existing open session.
- **Preserve honest records:** pending matches are discarded; confirmed unfinished matches become finished games with no result and a clearly marked estimated or unknown duration.

---

## Host Flow

- **Entry point:** `/g/:groupCode/start` reads the existing owner-only session list and filters by `endedAt === null`, regardless of date or `lastSessionCode`.
- **Choices:** each open session offers **Resume session** and **Close previous session and continue**. No age threshold applies; no session closes merely because the page was opened.
- **Confirmation:** show counts of pending matches, active matches, queued lineups, and the estimated duration before submitting. Explain that active matches count as played with no winner, so per-game billing can increase.
- **Multiple old sessions:** resolve one at a time, newest first. Session creation becomes available only after the list contains no open sessions. Existing roster drafts remain editable while the initial check loads. Resume leaves the current session open.
- **Late conflict:** a new session appearing while the host prepares a roster blocks creation with `GROUP_HAS_OPEN_SESSIONS`; retain the roster draft and display the same resolution controls.
- **Recovery:** closure and creation are separate operations. If closure succeeds but creation fails, the old session remains closed and the host retries creation without losing their roster.

---

## Closure Semantics

- **Pending pairings:** delete rows whose `confirmedAt` and `endedAt` are both null. They never count as played. Remove dependent `PairingShuttleUse` rows first if any exist; never delete shuttle identities.
- **Queued lineups:** delete `QueuedMatch` rows for the closed session; they never count as games.
- **Active pairings:** set `endedAt` to the actual closure timestamp, clear `winner`, `scoreA`, and `scoreB`, increment `revision`, and set `closedWithoutResultAt` to that same timestamp. Keep teams, `confirmedAt`, carry outcomes, and shuttle logs unchanged.
- **Finished pairings:** preserve all existing timestamps, scores, winners, revisions, and logs.
- **Session:** set `endedAt` and `closedAsForgottenAt` to the actual closure timestamp. Ordinary manual ending retains its existing unfinished-match refusal.
- **Repeated closure:** return the already-ended session without changing records. Existing result corrections remain available after closure; correcting a result does not silently replace an estimated duration.

## Duration Rules

- **Separate estimate:** add nullable `Pairing.estimatedDurationSeconds` and nullable `Pairing.closedWithoutResultAt`. Do not backdate `endedAt` to a guessed finish time.
- **Sample:** use only confirmed, finished, non-recovery matches in the same session with a positive recorded elapsed duration. Include normal finished no-result matches. Use all courts and both formats; do not add per-court or per-format heuristics in this version.
- **Average:** arithmetic mean in seconds, rounded once to the nearest whole second. Calculate from raw timestamp differences, not rounded per-match durations.
- **Cap:** for each active match, cap its estimate at its non-negative elapsed seconds as of closure. An estimate must not exceed the time the match could have run.
- **No sample:** store null; display **Duration unknown**. Never substitute zero or a default game length as an estimate.
- **Measured averages:** recovery matches never contribute to measured duration averages, even if they later receive a corrected winner.
- **Totals:** sum measured and estimated known durations into `totalSeconds`. Add `measuredTotalSeconds`, `measuredMatchCount`, `estimatedMatchCount`, and `unknownDurationMatchCount` to each summary player. Label totals as estimated when estimates are included, and partial when durations are unknown. The average uses only `measuredTotalSeconds / measuredMatchCount`.
- **Match payload:** `durationSeconds: number | null`; `durationSource: 'recorded' | 'estimated' | 'unknown'`. Legacy recorded matches retain their existing duration calculation.

---

## API and Consistency

- **Preview:** owner-only `GET /sessions/:code/close-preview` returns `{ code, endedAt, snapshotHash, pendingCount, activeCount, queuedCount, averageDurationSeconds }`.
- **Close:** owner-only `POST /sessions/:code/close-forgotten` accepts `{ snapshotHash }` and returns `{ code, endedAt }`.
- **Snapshot:** SHA-256 of a deterministic projection of session closure state, all pairing IDs/revisions/timestamps/estimate markers, and queued lineup IDs/positions/teams. Include finished matches because they determine the sample. Re-read within the closure transaction; a mismatch returns `SESSION_CLOSE_STALE` without writes.
- **Authorization:** both endpoints retain `AuthGuard` and `OwnershipGuard`. Anonymous callers are denied; a different owner receives 404. No public route exposes confirmation hashes.
- **Locks:** acquire the existing group lock, then the existing session lock, then perform the closure in one Prisma transaction. Never acquire them in reverse order. Use the same group lock as `createSession` and ladder editing.
- **Creation guard:** inside its existing group-locked transaction, authenticate the caller, honor an existing creation idempotency record, then query all open sessions before any player/alias/level/session writes. Return `GROUP_HAS_OPEN_SESSIONS` with `sessionCodes` if any remain.
- **Deployment assumption:** preserve the existing single API process model; no distributed lock or new dependency is introduced.

## Billing, History, and Existing Data

- **Games played:** recovered active matches count once as played. They have no win/loss and no winner-based Elo change. Confirm-time participation and partner history remain intact.
- **Billing:** the current engine bills games and shuttle records, not duration. Preserve physical counts, known/unknown shuttle-log markers, and frozen checkout receipts. No duration editor or new billing algorithm is needed.
- **Exports:** export the recovery markers and estimated duration alongside the existing pairing timestamps; do not let exported data imply the recovery duration was measured.
- **Migration:** add nullable columns with no backfill. Existing groups may have multiple open sessions; do not introduce a unique-open-session index that would reject existing data.
- **Correction:** preserve recovery markers when correcting winners or shuttle logs. Normal finish/undo paths must clear recovery duration fields when returning a game to a live lifecycle.

---

## Global Constraints

- **No background expiry job or inactivity timestamp.**
- **No new runtime dependencies.**
- **Thai is the source locale; English translations ship with every new user-facing string.**
- **Use existing authentication, ownership guards, group locks, session locks, and Prisma transactions.**
- **Server tests remain `fileParallelism: false`.**
- **Retain roster drafts and session-creation idempotency keys on errors and retries.**
- **No fabricated winners, scores, measured durations, or shuttle records.**

## Acceptance

- **Explicit consent:** visiting roster entry or previewing closure changes nothing.
- **Atomic closure:** stale confirmation or a failed transaction leaves every session, pairing, lineup, and receipt untouched.
- **Creation:** one open session blocks new creation; a retry of a successful creation returns its original session; two fresh concurrent creations produce at most one new open session.
- **Recovery:** ordinary and advanced sessions, empty sessions, multiple legacy open sessions, and no-duration-sample sessions can all be resolved.
- **Presentation:** match estimates, unknown durations, measured averages, and partial totals remain distinguishable in Thai and English.
- **Scope:** no automatic expiry, notification system, general duration editing, or unrelated session refactor.
