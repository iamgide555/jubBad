# JubBad - project audit and matchmaking gaps

Reviewed: 2026-09-07  
Reviewed commit: `e1a55211029a32e181e6a0e28a4cd5bc9b617481`  
Status: **Closed.** All 35 findings implemented and verified on 2026-09-07;
moved here from `docs/` on 2026-09-08 as a completed record. Findings 29-35
each required a product decision; the decision taken is recorded in that
finding's row and in the design-constraints section below.

Two of those decisions were later revisited by the owner, and the rows say so:
finding 33 was superseded (the partner metric became a win rate rather than a
rename) and finding 35 was extended (manual swap now completes what blocking
the confirm only reported). Both landed 2026-09-08. Read the rows as a record
of what was decided and when, not as current behaviour — `docs/overview.md` is
the source of truth for how the app works today.

## Purpose and implementation handoff

This document records the project audit for another model or developer to
implement. It covers matchmaking, court lifecycle, roster identity, API data
integrity, the live client, statistics, and operational maintenance.

The highest-priority problems are in how the API uses the matchmaking engine,
not in the Elo formula. The audit reproduced ways to hide an active match,
change teams after confirmation, skip players who have played fewer games, and
associate results with the wrong player.

Findings 1-28 are correctness, consistency, or maintenance issues established
from the current implementation. Findings 29-35 are design and quality gaps;
some describe deliberate current behavior rather than defects. Do not silently
treat every recommendation in that section as an approved product-policy change.

Implementation guidance:

- Preserve the finding IDs so implementation work can refer back to this list.
- Reproduce a finding before changing its behavior, and add a regression case
  that captures the intended outcome.
- Fix shared policies and state boundaries rather than adding unrelated
  special cases to proposal, fill, and substitution.
- Keep the distinction between all-time partner/opponent history, this-session
  rotation counts, actual played statistics, and fairness-only game offsets.
- Preserve public read-only player/display pages and protected admin operations.
- Run database-backed scenarios only against a dedicated temporary database.
  The default integration-test configuration is itself a finding below.
- Line references are relative to the repository root at the reviewed commit.
  They are navigation aids, not a substitute for reading the current code.
- This audit establishes the findings below; it does not guarantee that no
  other defects exist or constitute a dedicated penetration test.

Recommended implementation order:

1. Court lifecycle and identity integrity.
2. Shared fairness and mode-aware balancing rules.
3. Live-state and statistics consistency.
4. Search quality and explicitly chosen product improvements.

A larger randomized search will not fix state or identity problems.

## Matchmaking assessment

The pure engine's basic whole-round behavior is sound: it assigns distinct
players, respects court capacity, and prioritizes fewer games when selecting
the full playing pool. Several API operations do not preserve those rules.

The fixed 200-candidate search also had a measurable quality limit. Using
30 synthetic historical rounds and 100 seeded searches per roster, the audit
compared the engine's result with every possible arrangement. Lower scores
are better:

| Players / courts | Exact best score | Old average | Old worst | Old runs finding the optimum |
|---|---:|---:|---:|---:|
| 8 / 2 | 57 | 57.37 | 64 | 90/100 |
| 12 / 3 | 77 | 108.52 | 137 | 0/100 |

This did not mean every real session paired badly. It meant the search had no
quality guarantee as the roster grew.

**Resolved by finding 29.** The search now enumerates exactly for small
rosters and runs a local search for larger ones. Same methodology, same
seeds:

| Players / courts | Exact best score | New average | New worst | New runs finding the optimum |
|---|---:|---:|---:|---:|
| 8 / 2 | 57 | 57.00 | 57 | 100/100 (provably exact) |
| 12 / 3 | 77 | 77.02 | 78 | 98/100 |

Measured runtime per proposal: 0.6 ms for eight players over two courts,
14 ms for twelve over three, 40 ms for sixteen over four, and 171 ms for a
twenty-four player, six-court roster. The API proposes a whole round in one
call, so that is the cost of a single button press.
`engines/pairing-quality.test.ts` re-derives these numbers against exhaustive
enumeration on every test run.

### Measurement details

The comparison used variety mode, a fixed roster, and no games played in the
new session. Historical rounds were synthetic shuffled full-court assignments,
not a claim about actual production player behavior.

- Eight-player IDs: `a` through `h`; twelve-player IDs: `p0` through `p11`.
- Generate 30 historical rounds with `buildRandomArrangement`, using a single
  seeded random stream starting at 42.
- Derive partner/opponent counts from those rounds with `deriveHistory`, and
  leave the current-session history empty.
- For each search seed from 1 through 100, call `generateRound` with that
  history and the full court count.
- The seeded stream uses unsigned 32-bit state:
  `state = (Math.imul(state, 1664525) + 1013904223) >>> 0`, returning
  `state / 4294967296`.
- Compare results with exhaustive enumeration of disjoint four-player groups
  and all three doubles splits per group, ignoring court/team permutations.
  This gives 315 arrangements for eight players and 155,925 for twelve.
- Score both exhaustive and engine arrangements with the same
  `scoreArrangement` and `historyFloors`.

The audit also exercised 144 pure-engine roster/court combinations: roster
sizes 1-24 and court counts 1-6. Those scenarios preserved assignment
uniqueness, capacity, and full-pool games-played priority.

### Audit execution baseline

At the reviewed commit:

| Existing suite | Outcome |
|---|---|
| Engine tests | 74 passed |
| Server tests, using an isolated migrated SQLite database | 132 passed |
| Web tests, non-watch mode | 140 passed |
| Server end-to-end entry point | Failed: expected anonymous `/` to return 200, received 401 |

Additional temporary audit probes reproduced the counterexamples recorded
below. Those probes and their isolated database were removed after the review;
they were not committed as regression tests. The suite results above do not
mean the listed gaps are covered by existing tests.

## 1. Matchmaking and court-state issues

In this section, **S** means
`server/src/sessions/sessions.service.ts`.

| ID | Priority | Issue and impact | Solution |
|---|---|---|---|
| 1 | **High** | **Proposing on an active court creates another open match.** Reproduced two open rows on one court; the dashboard then showed the newer pending match instead of the active one. `S:233-285` | Reject proposals when the target court is active. Add a database constraint allowing only one unfinished pairing per session/court. |
| 2 | **High** | **Court numbers are not range-checked.** Court `99` was accepted in a one-court session. That invisible match reserves players and prevents normal session completion. `S:215` | Require an integer between `1` and the session's court count for every court operation. Reject invalid requests before any write. |
| 3 | **High** | **Lifecycle operations are only partially serialized.** Reproduced reshuffle changing teams after confirmation; finish racing with undo producing an ended-but-unconfirmed match; and session end racing with proposal leaving an ended session with an unfinished match. `S:338-380,541` | Put all state-changing session operations under the same lock. Use transactional, conditional updates and pairing revisions so stale requests cannot confirm a different proposal than the host reviewed. |
| 4 | **High** | **Single-court proposals can bypass rotation fairness.** The service plans multiple idle courts but commits only the first. With four players on zero games and four on five games, one proposal selected three five-game players while three zero-game players remained waiting. `S:267-285` | Enforce games-played priority for the court actually being committed. Retain cross-court planning only where it cannot sacrifice that priority; batch fill can optimize all committed courts together. |
| 5 | **High** | **Swapping prioritizes pairing history over games played.** A substitute with five games was selected over one with one game. Normal generation makes games played the first selection criterion. `S:440-455` | Select eligible substitutes by the same rotation policy as normal generation, then use arrangement scoring to choose among equally eligible candidates. |
| 6 | **High** | **Swapping ignores balanced mode.** It never supplies ratings to `scoreArrangement`. A reproduced swap produced a roughly 94-point team gap despite an available substitute giving a 12-point gap. `S:447-451` | Reuse the same mode-aware scoring policy for proposal, fill, and substitution, including group-wide Elo in balanced mode. |
| 7 | **Medium** | **The 10:1 weighting does not guarantee partner-repeat priority.** A reachable history makes a repeated partnership cost `10`, while both fresh-partner alternatives cost `11` from opponent repeats. The documented "never trade a partner repeat" promise therefore fails. `engines/pairing.ts:138-148` | If that promise is required, compare partner and opponent costs lexicographically in variety mode. Otherwise explicitly document that partner avoidance is a weighted preference, not a guarantee. |
| 8 | **Medium** | **Fill-all is not atomic.** When the second court write failed, the first remained committed despite the overall operation failing. `S:645-660` | Commit the entire generated assignment in one database transaction, inside the session lock. |
| 9 | **Medium** | **Ended sessions still accept roster changes.** Rest/reactivate succeeds after session completion and can change fairness offsets and activation timestamps. `S:666` | Check session completion inside the lock and reject roster mutations on ended sessions. |

### Important reproductions and acceptance conditions

**Finding 1:** Create a session, propose court 1, confirm it, and propose court 1
again. The second call currently creates another open row. The fix must leave
the original active match unchanged and refuse the second proposal. Exercise
both direct API calls and a stale admin tab.

**Finding 2:** In a one-court session, propose court 99. The call currently
succeeds even though `getSession` only returns the configured visible courts.
Cover zero, negative, out-of-range, and non-integer court identifiers.

**Finding 3:** Deterministically pause operations at read/write boundaries
rather than depending on a race appearing during a timing-based test:

- Pause reshuffle before its pairing update, confirm the old proposal, then
  allow reshuffle to write. Confirmed teams must not change.
- Pause finish before its update, undo confirmation, then allow finish to
  write. An ended-but-unconfirmed record must never be created.
- Pause session end after it finds no unfinished pairing, create a proposal,
  then allow session end to write. An ended session must not contain a new
  unfinished pairing.

Serialization alone does not address a host confirming a proposal that was
already replaced before their request arrived. Include expected-version
preconditions for that stale-client case.

The existing lock is in-process and suits the current single-API-process
deployment. It must not be described as a multi-process guarantee.

**Finding 4:** Use two idle courts and players `a` through `h`, where `a-d`
have zero games and `e-h` have five. With the seeded random stream described
above and seed 1, the first planned court contained `e,g,h,a`; `b,c,d` were
left waiting when only that court was committed.

**Finding 5:** One concrete pending lineup is `A+B` versus `C+D`, swapping
out `A`, with substitutes `E` and `F`. Give `E` five prior games as `E+C`
versus `A+D`, and `F` one prior game as `F+B` versus `C+D`. The current
history-first substitution scoring picks `E`, despite `F` having fewer games.

**Finding 6:** Use balanced mode with a pending `A+B` versus `C+D`, replacing
`A`, and only `E` and `F` available as substitutes. In a previous session,
record 60 losses by `E+X` against `Y+Z`, followed by one win by `F+B` against
`Y+Z`. Keep `X,Y,Z` out of the current substitute pool. Current substitution
picks `E` based on variety alone: the gap is approximately 93.56 versus 12.14
for `F`. The comparison uses ratings recomputed from that same history.

**Finding 7:** A valid historical counterexample is one match `A+B` versus
`X+Y`, followed by 11 matches `A+X` versus `B+Y`. With only `A,B,C,D` currently
available, `A+B` versus `C+D` costs 10, while either fresh-partner alternative
costs 11. This is a scoring-policy issue, not a search-sampling failure.

**Finding 8:** Inject a failure on the second pairing insert during a
two-court fill. No newly generated pairing should persist if the operation
reports failure under the proposed all-or-nothing contract.

## 2. Roster import and data integrity

Here, **S** still refers to
`server/src/sessions/sessions.service.ts`.

| ID | Priority | Issue and impact | Solution |
|---|---|---|---|
| 10 | **High** | **Numbered nicknames can resolve to the wrong person in later sessions.** With stored players `ตั้ม` and `ตั้ม (2)`, importing only `ตั้ม (2)` matched the first player because both names normalize identically. This misattributes ratings and history. `engines/fuzzy-match.ts:8-11,74-80` | Try literal name/alias matches before lossy normalization. Preserve identity-bearing suffixes and require disambiguation when multiple players share a normalized name. Allow the host to override an exact match. |
| 11 | **High** | **Duplicate decisions can silently remove a real player.** Reject the first fuzzy suggestion as a new person, then accept a later entry marked duplicate: the later entry is unconditionally skipped even though its existing player was never added. `engines/fuzzy-match.ts:142`; `S:49` | Resolve final decisions before deduplicating by resolved player ID. "Accept existing player" should resolve that identity, not unconditionally discard the row. |
| 12 | **High** | **Session creation trusts incomplete or invalid identity data.** A missing nested `match` passed validation and caused a TypeError. A nonexistent player ID was persisted in the roster. Player membership in the requested group is also not enforced. `server/src/sessions/dto/create-session.dto.ts:17`; `server/src/sessions/dto/name-match.dto.ts:7`; `S:21-99` | Require the nested object and type-dependent fields. Validate referenced players against the group inside the transaction. Add player foreign keys where appropriate and return clear 400-level errors. |
| 13 | **Medium** | **Double-submit creates duplicate sessions and player records.** The roster confirmation button has no in-flight guard, and creation has no idempotency mechanism. Two identical submissions created two sessions and two records for the same newly imported name. `web/src/app/pages/group-entry/group-entry.ts:181`; `S:21` | Disable confirmation while submitting and attach an idempotency key that the server enforces. Do not use name uniqueness as the fix: different people can share names. |
| 14 | **Medium** | **A numbered `@All` mention can become the roster.** Input beginning `1. @All` imported `@All` as the player and moved the actual roster into unrecognized lines. This format even appears in the parser's example. `engines/parser.ts:257-282` | Exclude notification mentions from roster-start detection and numbered player parsing. |
| 15 | **Medium** | **Invalid dates and ambiguous years are accepted without warnings.** `31/02/2026` became `2026-02-31`; `8/9/60` became 2060 with no ambiguity warning. `engines/parser.ts:130-166` | Validate real calendar dates, including leap years. Surface two-digit-year ambiguity for confirmation, and validate submitted dates again in the API. |
| 16 | **Medium** | **Scores can contradict the recorded winner.** `{scoreA: 0, scoreB: 21, winner: 'A'}` passes validation. One-sided scores are accepted too. `server/src/sessions/dto/finish-pairing.dto.ts:3-20` | Accept either no scores or a complete valid score pair. Check consistency with the winner; keep the explicit no-result path. |

### Important reproductions and acceptance conditions

**Finding 10:** Store two distinct identities whose names normalize to the same
value, then import only the second one in a later session. Correctness must
not depend on database result order. Cover conflicting aliases as well as
numbered names. Do not repair this by enforcing globally unique nicknames.

**Finding 11:** With existing player `Bobby`, `Boby` and `Bobbi` both produce
fuzzy candidates for that identity. The second becomes a duplicate due to the
first tentative claim. If the host rejects `Boby` as a different person but
accepts `Bobbi` as the existing player, both distinct resolved players must
remain in the final roster.

**Finding 12:** Cover absent/null nested matches, missing player IDs for
identity-bearing match types, nonexistent IDs, and IDs belonging to another
group. Invalid imports must not leave partially created sessions or players.
Database existence constraints do not replace group-membership validation.

**Finding 13:** Cover simultaneous identical requests and a retry after the
first request committed but the client did not receive its response. A
client-only disabled button is not sufficient for the latter.

**Finding 14:** Include this shape:

```text
1. @All
Badminton 8/9/2026
19.00-20.00
1. A
2. B
```

The player list must contain `A` and `B`, not `@All`.

**Finding 15:** Include impossible day/month combinations, leap days, valid
four-digit Gregorian years, four-digit Buddhist years, and ambiguous
two-digit years. Ambiguity should not be silently resolved as certainty.

**Finding 16:** Keep support for a winner with both scores absent and for an
explicit no-result match. Do not accidentally introduce mandatory score entry
or a live scoring workflow.

## 3. Live UI and statistics

| ID | Priority | Issue and impact | Solution |
|---|---|---|---|
| 17 | **Medium** | **The stats table does not refresh after results or undo.** Its resource depends only on session code and selected scope; mutations reload a different resource. `web/src/app/pages/session-dashboard/stats-table/stats-table.ts:19`; `web/src/app/core/live-session.service.ts:84` | Invalidate stats after finish/undo, using a shared mutation revision or explicit refresh event. |
| 18 | **Medium** | **A second admin dashboard remains stale.** The dashboard interval only advances the clock; unlike the display, it does not reload session data. Old buttons can act on outdated courts. `web/src/app/pages/session-dashboard/session-dashboard.ts:66-67` | Add modest polling and refresh on focus/reconnection. Combine this with server-side revision checks; polling alone cannot prevent stale writes. |
| 19 | **Medium** | **"Played" means different things on different screens.** After a no-result match, session stats reported one game while the player card reported zero, because profile history excludes matches without winners. `server/src/groups/groups.service.ts:104-128`; `server/src/sessions/sessions.service.ts:713` | Share one statistics definition. Count finished played matches consistently, while calculating Elo and decisive-result win rate from the appropriate subset. |
| 20 | **Medium** | **Session archive counts include unconfirmed proposals.** A session with no played matches already reports one match after proposing. `server/src/groups/groups.service.ts:89` | Count confirmed or finished matches according to the displayed label; keep pending proposals separate. |
| 21 | **Medium** | **Loading, missing data, expired authentication, and network failures are conflated.** Home loading failure can look like "no groups"; session errors look like "not found"; import/create/rename failures lack useful recovery. `web/src/app/pages/landing/landing.ts:46`; `web/src/app/pages/group-entry/group-entry.ts:99,124,181`; resource-backed pages | Model loading, empty, 404, 401, and transient failure separately. Preserve entered data, show retry controls, and handle expired login without pretending data disappeared. |
| 22 | **Low** | **Archived sessions keep accumulating waiting minutes.** Their waiting list still uses the current clock even after the session ended. `web/src/app/pages/session-dashboard/session-dashboard.ts:69-80` | Hide the live queue for ended sessions or freeze calculations at `endedAt`. |
| 23 | **Low** | **Clipboard failure offers a fallback that is not present.** The message says to select the text manually, but the generated display URL, player URL, or share text is not exposed in a selectable field. `web/src/app/pages/session-dashboard/session-dashboard.ts:161-179`; `web/src/app/pages/session-dashboard/stats-table/stats-table.ts:41-46` | Show the exact text or URL in a selectable read-only field when copying fails. |
| 24 | **Medium** | **Error messages bypass localization.** Parser warnings are English in the Thai UI; server lifecycle errors are Thai and override translated fallbacks in the English UI. `engines/parser.ts:163-187`; `web/src/app/core/live-session.service.ts:88-92` | Return stable error/warning codes plus parameters, and translate them in the client. |

### Important acceptance conditions

- Finish and undo must update the visible statistics without navigating away,
  toggling scope, or manually reloading the browser.
- Use two admin clients for synchronization scenarios. Ensure a stale client
  cannot mutate a replacement proposal merely because its pairing ID is
  unchanged.
- Separate actual played counts, decisive-result counts, win-rate denominators,
  and Elo eligibility. A no-result match must not become a fabricated loss.
- Pending proposals must not appear as completed matches in archive summaries.
- Authentication expiry and temporary server failure must preserve the host's
  pasted roster and other unsaved input.
- Ended-session displays must not accumulate fictional waiting time.
- Clipboard fallback must expose locale-correct links, including `/en/`.
- Exercise warning and error paths in both supported locales, not just static
  template labels.

## 4. Operational and maintenance issues

| ID | Priority | Issue and impact | Solution |
|---|---|---|---|
| 25 | **Medium** | **Login throttling collapses users behind nginx into one address bucket.** The controller uses `req.ip`, but Express is not configured to trust the proxy. Forwarding `X-Real-IP` alone does not change it. Ten failed attempts can block other users for 15 minutes. `server/src/auth/auth.controller.ts:42`; `web/nginx.conf:28`; `server/src/main.ts` | Configure trusted proxy handling for the actual Cloudflare -> nginx -> API chain. Sanitize forwarded client identity at the trusted edge; do not trust arbitrary client-supplied headers. |
| 26 | **Medium** | **Integration tests default to the configured application database.** The round-trip test also deletes fixed `test-group` / `test-session` identifiers in cleanup, risking collisions and destructive cleanup of pre-existing records. `server/vitest.config.ts:1`; `server/src/prisma-roundtrip.spec.ts:61-65` | Always create a dedicated temporary database for the suite, migrate it automatically, and use unique fixture identifiers. |
| 27 | **Medium** | **The existing end-to-end entry point is outdated.** It expects anonymous `GET /` to return 200, but current authentication returns 401. `server/test/app.e2e-spec.ts:18-23` | Update the scenario for the current auth boundary, share production bootstrap configuration, and exercise login -> import -> propose -> confirm -> finish. |
| 28 | **Low** | **Product documentation contradicts current behavior.** It still describes no authentication, code-only export/delete access, and manual-only display refresh. `docs/overview.md:38-44,280`; the old backlog also retains obsolete access assumptions | Done, then **completed a second time on 2026-09-07**: the first pass fixed `docs/overview.md`'s risk table but missed the backlog half of this finding and one stale paragraph in the overview's "Current state". Backlog entry B12 and the "Export and delete: accepted risk" section both still argued from the pre-auth world. Both are now revised, and B12 defers on what is actually still missing rather than on a risk that has been closed. Worth noting as a pattern: a superseded decision tends to be restated in more places than the one that gets grepped. |

### Important acceptance conditions

**Finding 25:** The audit confirmed that Express's current default handling
returns the same socket-derived source address even when two requests carry
different `X-Real-IP` headers. Validate the full deployed proxy chain, not just
a controller unit test with a fabricated `req.ip`. Do not enable unrestricted
proxy/header trust as a shortcut.

**Finding 26:** Tests must not fall back to the developer's configured database
when their temporary database setup fails. Cleanup must target only resources
created by that test run.

**Finding 27:** Supply a test-only admin token, apply the same relevant
middleware and validation configuration as production, and retain assertions
that anonymous administrative requests are refused. Do not make `/` public
merely to preserve the old scaffold test.

**Finding 28:** Distinguish the implemented shared admin-token boundary from
per-user accounts or per-group host roles. The presence of admin authentication
does not mean those separate product features have been implemented.

## 5. Design and quality gaps, not confirmed production bugs

These are not all equivalent to the correctness defects above. Confirm the
intended policy before implementing behavior changes.

| ID | Gap | Recommended solution |
|---|---|---|
| 29 | *Implemented 2026-09-07.* **Search quality dropped with larger arrangements.** The measured twelve-player case consistently missed the optimum. `engines/pairing.ts` | Done as recommended. Court scores are independent, so each court's split is now chosen exactly for a given grouping. Rosters of eight or fewer playing are enumerated outright (provably optimal); larger rosters use random restarts feeding a steepest-descent local search over cross-court player swaps, scored incrementally because a swap only touches two courts. Twelve players over three courts went from 0/100 to 98/100 optimal runs. `engines/pairing-quality.test.ts` benchmarks against exhaustive enumeration. |
| 30 | *Implemented 2026-09-07.* **The visible waiting queue was not the engine's selection order.** The UI sorted by waiting time while equal-game selection was random. `engines/pairing.ts`; `web/src/app/core/waiting-time.ts` | Adopted as recommended: games played first, longest wait second, random only for remaining ties. `engines/waiting.ts` now holds the one definition of when a wait started, used by the engine, the API and both screens. The session payload reports `queueGames` (games plus fairness offset) so the displayed queue is ordered exactly the way the engine selects. |
| 31 | *Implemented 2026-09-07.* **Changing court availability during the evening was not represented.** The parser recognized multiple time slots, but the API kept only the first slot's court count and the session had one fixed count. `engines/parser.ts`; `server/src/sessions/sessions.service.ts` | Both halves of the recommendation, not the scheduling engine. The parser now warns when slots book different counts, naming each slot and its count, so the import review says plainly that only the first is applied. `POST /sessions/:code/court-count` then lets the host change it live; it refuses to shrink past a court with an unfinished match (`COURT_IN_USE`, listing the courts) instead of cancelling play, and the dashboard has a stepper beside the mode toggle. Scheduled availability is deliberately not built: it would need the session to know the wall clock, and the manual change covers the real booking pattern. |
| 32 | *Implemented 2026-09-07.* **No automated backup/restore workflow was defined in the repository.** `server/scripts/backup-db.mjs`; `server/scripts/restore-db.mjs`; `dockerDeploy.md` | Took the first option: SQLite-consistent backups, retention, and a written restore procedure. `npm run db:backup` uses SQLite's online backup API (not a file copy — WAL means a copy is torn), verifies the result with `integrity_check`, and prunes to 30 days but never below 7 files. `npm run db:restore` refuses a corrupt backup, moves the live database aside instead of overwriting, and deletes the stale `-wal`/`-shm` that would otherwise be replayed over the restored file. Both ship in the image, so the nightly cron is one `docker compose exec`. The JSON export was explicitly *not* promoted to a restore format — it is documented as read-only, which is cheaper and more honest than versioning a second serialisation of the same state. |
| 33 | *Implemented 2026-09-07.* **"Best partner" did not match user expectations.** The documented rule ranks wins, then more games played, so it chooses 2 wins from 9 over 2 from 2. `server/src/groups/groups.service.ts` | First took the labelling option — renamed to `mostWinsWith` so the name matched the arithmetic. **Superseded on 2026-09-08:** the owner confirmed best partner was always meant to be best *win rate* together, so the metric changed instead. Now `bestPartner`, a win rate over a floor of 5 decisive games, ties to the more-played pair, falling back to a `provisional` count below the floor. The lesson: I resolved a name/behaviour mismatch by assuming the behaviour was the intended one, when the name was. Worth asking next time rather than inferring from the older document. |
| 34 | *Implemented 2026-09-07.* **Engine failure handling disguised abnormal input.** Corrupt history produced "no courts," which became "not enough players." `engines/pairing.ts`; `server/src/sessions/sessions.service.ts` | `validateRoundInput` now runs before any work and throws `InvalidRoundInputError` for a duplicated or empty player id, a fractional or negative court count, a negative or non-finite count in any history map, a non-finite rating, or an `avoidSplit` that does not name four distinct players. The API maps it to 500 `INVALID_SESSION_STATE` with the detail, and the client says the data is wrong rather than blaming the roster. An empty roster is still an ordinary empty round, not an error. The repeated-split half was already removed by finding 29: the exclusion now applies to one split of court 1, so a legal alternative always survives and there is no sampling exhaustion to fall back from. |
| 35 | *Implemented 2026-09-07.* **Resting a player did not invalidate an existing pending proposal**, so that player could still be confirmed onto court. `server/src/sessions/sessions.service.ts`; `web/src/app/pages/session-dashboard/court-panel/` | Exactly as recommended. Confirmation revalidates availability and rejects with 409 `PLAYER_UNAVAILABLE`, naming the players; active matches are untouched, so someone marked as leaving still finishes the game they are in. The proposal itself is left standing rather than rewritten — silently reshuffling under a host who is reading it aloud is worse than refusing. The court panel names the rested player, disables confirm, and points at the two fixes (swap that name, or reshuffle); both already draw only from active players, so either one clears it. | **Extended 2026-09-08:** blocking the confirm told the host what was wrong but still left rotation to choose the fix. Manual swap now completes it — pick a player up and drop them where you want, including trading two pending courts. The auto-pick tap is unchanged, so the fast path stayed fast.

### Design constraints for these improvements

**Finding 29 (implemented).** Compared against exact small-roster solutions
rather than one attractive lineup. Runtime was measured before and after: the
first working version scored a whole round per candidate and took 946 ms for a
twenty-four player roster, which incremental two-court scoring and an
early-stop on unproductive restarts brought to 171 ms. The exhaustive cutoff
is eight playing because that is 315 arrangements against 155,925 for twelve.
A side effect worth knowing: the reshuffle exclusion now removes a single
split of court 1 rather than discarding a whole candidate, so a legal
alternative always remains and the old "repeat the avoided split" fallback is
gone.

**Finding 30 (implemented).** The activation-aware calculation was reused
rather than reimplemented: `engines/waiting.ts` takes the latest of session
start, last match end, and activation, so a late arrival gets no credit for
time before they joined. Fairness offsets stay out of statistics — `queueGames`
is documented as rotation-only, and a server test asserts that a player
credited with two offset games still reports one game played. Note that a wait
can never predate the session, which matters when writing fixtures: a session
created "now" floors every wait to the same value.

**Finding 31 (implemented).** A representative imported schedule has one court
from 19:00-20:00 and three courts from 20:00-22:00. The constraint was
respected: the first slot's count is still what the session starts on, the
maximum is never substituted, and the host is told about the later slot rather
than having a number guessed for them. Growing the count is free; shrinking is
guarded, because the players on a court that would disappear are physically
standing on it.

**Finding 32 (implemented).** This was a gap in the repository-defined
workflow, not proof that no external backup existed on the deployment host. The
WAL constraint drove the design: the online backup API rather than any file
copy, and journal removal on restore. Two limits are stated rather than papered
over — the backups sit on the same disk as the database, so they cover a bad
migration but not a lost machine, and retention has a floor because an
age-only rule deletes the last copy once the scheduler stops.

**Finding 33 (implemented).** The existing ranking is an explicit product
choice in `docs/2026-09-05-review-and-v2-backlog.md`, so the metric was left
alone and the claim was brought into line with it instead. The backlog entry
was updated too — the contradiction lived in three places, and fixing only the
code comment would have left the next reader trusting the doc.

**Finding 34 (implemented).** Sampling exhaustion was never proof that there
are no alternatives, and the search rewrite in finding 29 removed the sampling
entirely. What remained was the disguised-input half. One judgement worth
recording: the validation deliberately does not require history keys to name
players in tonight's roster — history is all-time and mostly concerns people
who are not here — and an existing test that asserted corrupt counts degrade
quietly to an empty round was rewritten, because that behaviour was the defect
rather than a contract.

**Finding 35 (implemented).** Pending and active pairings are distinguished, and
a player rested during an active match still finishes it — both covered by
tests. The check lives at confirmation rather than at the moment of resting,
which is what keeps the two cases apart without the host having to remember
which courts had proposals open.
