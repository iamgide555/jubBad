# Host Pair Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let hosts enforce persistent pair rules in every pairing mode while retaining explicit, recoverable failure when no legal match exists.

**Architecture:** Group-owned rules and session-only disable IDs feed a pure constraint-aware pairing engine; normal scoring runs only on legal candidates. The server rechecks rules at edits/confirmation and snapshots linked carry decisions on `Pairing`; host-only editors expose rule management and blocked-lineup repair. With no enabled rules, preserve the current engine and UI behavior.

**Tech Stack:** Dependency-free TypeScript engines (`node:test`), NestJS/Prisma/SQLite (Vitest), Angular standalone components/signals (`ng test`).

**Spec:** `docs/archive/specs/2026-09-30-pair-rules-design.md`

## Global Constraints

- Three rule kinds: `must-pair`, `never-teammates`, `never-same-court`. Enabled rules are hard constraints in variety, balanced, level, and custom modes; no manual override without switching the rule off for this session.
- A must-pair duo is one two-seat doubles unit when both roster entries are active, otherwise the available player plays normally. At most one must-pair link per player; order-normalize IDs and reject self/cross-group/conflicting links.
- Rules do not alter partner/opponent history. Active matches are grandfathered; pending matches, manual edits, and the auto-confirm sweep recheck current rules. Never expose rule data on public routes.
- Linked tagged players consume their carry chance only after an actual higher-level teammate while currently far-below. Record `null` outcomes even if not far-below yet; unlinked and legacy first-game behavior stays unchanged. Undo confirm removes the outcome; undo finish does not.
- With rules enabled, exact enumeration covers up to eight playing players. Larger-roster feasibility has a limit of **100,000 explored partial assignments** per proposal/mode group; an inconclusive result is `PAIR_RULE_SEARCH_LIMIT`, never "no legal match." With no applicable rules, preserve seeded outcomes.
- Bilingual Thai-primary/English copy, 44px-or-larger host controls, existing single-container session serialization and ownership mismatch 404. Do not install engine dependencies.

## Review Focus

Five inputs easy to miss, each pinned to a task below:

1. Two simultaneous group writes assigning different must-pair partners to one player must leave exactly one rule (Task 1).
2. A session toggle naming a rule from another group must return 404 and not disable anything (Task 2).
3. An enabled rule excluding the current doubles split must take priority over shown-split avoidance without returning an illegal split (Task 3).
4. A rule added just before auto-confirm sees an already-full pending match and blocks the timer without blocking an unrelated court (Task 5).
5. A tagged linked player who becomes far-below only after a roster change must not retroactively consume carry on an earlier unsuitable game (Task 5).

## File map

- `server/prisma/schema.prisma` plus generated migration: `PlayerRule`, `Session.disabledRuleIds`, `Pairing.carryOutcomes`. `server/src/groups/groups.{controller,service}.ts` and DTOs: owner-guarded rule CRUD, group export/deletion and atomic per-group writes.
- `server/src/sessions/session-rules.ts`: parse/validate disabled IDs and select enabled/applicable rules. `sessions.{controller,service}.ts`: session rule state and serialized per-rule toggles.
- `engines/pair-rules.ts`: typed rules, legality and feasibility errors; `engines/pairing.ts`: legal candidate generation, selection, constrained local search, carry and custom completion. Keep the no-rule route unchanged.
- `server/src/sessions/carry-eligibility.ts`, `sessions.service.ts`: carry outcome snapshot and rule-aware lifecycle/engine calls, including fill-all.
- `web/src/app/core/roster.service.ts`, `live-session.service.ts`, host roster/dashboard components and locale catalogs: manage persistent rules and session switches; public models unchanged.
- `docs/overview.md` and the C checklist in `docs/2026-09-27-real-host-feedback.md`: update only once shipped. The host-feedback file was untracked when this plan was written: do not stage its unrelated contents without permission.

### Task 1: Group rule storage, CRUD, export, deletion

**Files:** Create `engines/pair-rules.ts` (types only for now), `server/src/groups/dto/set-player-rule.dto.ts` and a Prisma migration under `server/prisma/migrations/`; modify `server/prisma/schema.prisma`, `server/src/groups/groups.controller.ts`, `server/src/groups/groups.service.ts`, `server/src/groups/groups.controller.spec.ts`, `server/src/admin/delete-user.spec.ts`.

**Interfaces:** Produce engine types `RuleKind = 'must-pair' | 'never-teammates' | 'never-same-court'`, `PairRule = {id:string;playerAId:string;playerBId:string;kind:RuleKind}` and Prisma `PlayerRule` with `{id,groupId,playerAId,playerBId,kind,createdAt}`, `Session.disabledRuleIds String? @default("[]")`, `Pairing.carryOutcomes String @default("[]")`. Host-only `GET/POST /groups/:code/rules`, `PUT/DELETE /groups/:code/rules/:ruleId`; POST takes `{playerAId,playerBId,kind}`, PUT takes `{kind}` and preserves ID/pair. Each write checks both player group IDs and normalizes order. `GroupsService` uses a per-group `SessionLock` instance for rule mutations.

- [x] **Step 1: Write failing integration tests** `group rule ...` in `groups.controller.spec.ts`: sorted pair is unique; self/cross-group/second must-pair link rejected; concurrent `Promise.all` creates for `A-B` and `A-C` result in exactly one success; replacing kind preserves ID and session disable reference; group export includes rules, disabled IDs and pairing outcomes; group and admin multi-group deletion remove rules before players. The groups controller fixture has no AuthModule, so use the generic auth boundary sweep in Task 2 to prove new routes are host-only.
- [x] **Step 2: Run red:** `cd server && npx vitest run src/groups/groups.controller.spec.ts -t "group rule"`. Expected FAIL on absent schema/routes.
- [x] **Step 3: Add schema and generate migration** with `cd server && npx prisma migrate dev --name pair_rules`; implement DTO, guarded group routes and service methods `listRules(code: string)`, `createRule(code: string, dto: SetPlayerRuleDto)`, `setRuleKind(code: string, ruleId: string, kind: RuleKind)`, `deleteRule(code: string, ruleId: string)`. Revalidate inside the per-group lock, use the new table's unique pair constraint, and update `exportGroup`/`buildDeleteGroupOps`.
- [x] **Step 4: Run green:** targeted `npx vitest run src/groups/groups.controller.spec.ts -t "group rule"` from `server/`, then `npx vitest run src/admin/delete-user.spec.ts` and `npm run build`. Expected PASS; never reset a shared dev DB to force a migration.
- [x] **Step 5: Commit** only migration/schema/group-code/test hunks: `git commit -m "feat(server): manage persistent pair rules"`.

### Task 2: Session-level rule switches and validation

**Files:** Create `server/src/sessions/session-rules.ts`, `server/src/sessions/session-rules.spec.ts`, `server/src/sessions/dto/toggle-pair-rule.dto.ts`; modify `server/src/sessions/sessions.controller.ts`, `server/src/sessions/sessions.service.ts`, `server/src/sessions/sessions.controller.spec.ts`.

**Interfaces:** Consume Task 1 `PlayerRule` and `Session.disabledRuleIds`. Produce `parseDisabledRuleIds(raw: string | null): string[]` (malformed non-null throws), `enabledRules(rules: readonly PlayerRule[], disabledIds: readonly string[]): PlayerRule[]`, `applicableRules(rules: readonly PlayerRule[], activeIds: ReadonlySet<string>): PlayerRule[]`; host-only `GET /sessions/:code/rules` returns `{rules, disabledRuleIds}`, `POST /sessions/:code/rules/:ruleId/toggle` takes `{enabled: boolean}` and modifies only that ID under the session lock. Do not put these fields in public `GET /sessions/:code`.

- [x] **Step 1: Write failing tests:** null/`[]` parsing; malformed or duplicate ID list fails as `INVALID_SESSION_STATE`; a disabled rule stays active in another session; an ID from another group is 404; deleted IDs are inert; two concurrent switches of different IDs preserve both. Add an anonymous/owner-mismatch test for the host-only GET and POST (no public rule leak).
- [x] **Step 2: Run red:** `cd server && npx vitest run src/sessions/session-rules.spec.ts src/sessions/sessions.controller.spec.ts -t "session rule"`. Expected FAIL.
- [x] **Step 3: Implement helper and DTO/routes** plus `SessionsService.getSessionRules(code: string)` and `toggleSessionRule(code: string, ruleId: string, enabled: boolean)`; do read-modify-write inside `SessionLock`, verify group membership, and have group writes become visible to subsequent reads. Use the existing ownership guard on `:code`.
- [x] **Step 4: Run green:** same targeted Vitest selectors, then `cd server && npx vitest run src/auth/auth.boundary.spec.ts` for complete route sweep. Expected PASS.
- [x] **Step 5: Commit** only session rule helper/DTO/controller/service/tests: `git commit -m "feat(server): toggle group rules per session"`.

### Task 3: Hard legal court groups and custom completion

**Files:** Create `engines/pair-rules.test.ts`; modify `engines/pair-rules.ts`, `engines/pairing.ts`, `engines/pairing.test.ts`.

**Interfaces:** Consume Task 1 `RuleKind` and `PairRule`. Produce `assertValidPairRules(roster: readonly string[], rules: readonly PairRule[]): void`, `isLegalCourt(teamA: readonly string[], teamB: readonly string[], rules: readonly PairRule[]): boolean`, `NoLegalRuleMatchError`, `PairRuleSearchLimitError`. Append optional `rules?: readonly PairRule[]` and `ruleFillPolicy: 'requested' | 'partial' = 'requested'` to `generateRound(...)`; append optional `rules?: readonly PairRule[]` to `completeCourt(...)`, preserving no-rule behavior and existing argument order.

- [x] **Step 1: Write failing tests:** four-player legal and impossible never-same-court cases; must-pair occupies one doubles team; never-teammates may oppose but not partner; a sole legal split repeats despite `avoidSplit`/`shownSplits`; custom `completeCourt` honors already seated players and rejects a full violating lineup; invalid overlapping/self/cross-roster rule data throws `InvalidRoundInputError` rather than producing empty courts.
- [x] **Step 2: Run red:** `node --experimental-strip-types --test engines/pair-rules.test.ts engines/pairing.test.ts`. Expected FAIL.
- [x] **Step 3: Implement legality/validation and exact constrained enumeration** within `pair-rules.ts` and the existing split/arrangement selection in `pairing.ts`; allow `NoLegalRuleMatchError` only after actually checking all legal candidates for the chosen available players. The no-rule branch keeps the old seeded result byte-for-byte. `completeCourt` must distinguish "not enough available people" (`null`) from a rule conflict (typed error).
- [x] **Step 4: Run green:** same `node --test` command. Expected PASS.
- [x] **Step 5: Commit** only engine and test hunks: `git commit -m "feat(engine): filter illegal pair-rule matches"`.

### Task 4: Joint sit-out units, larger search, carry construction

**Files:** Modify `engines/pairing.ts`, `engines/pair-rules.ts`, `engines/pair-rules.test.ts`, `engines/pairing-quality.test.ts`.

**Interfaces:** Consume Task 3 `PairRule`, legal-court predicate and typed errors. Extend `selectSittingOut(..., rules?: readonly PairRule[])` and `generateRound(..., rules?, ruleFillPolicy?)`. Produce `searchLegalAssignments(input: LegalSearchInput): {status:'found';courts:{courtIndex:number;players:PlayerId[]}[];sittingOut:PlayerId[]} | {status:'impossible'|'limit'}` in `pair-rules.ts`. `LegalSearchInput` has `roster: readonly PlayerId[]`, `sizes: readonly CourtSize[]`, `rules: readonly PairRule[]`, `gamesPlayedThisSession: ReadonlyMap<PlayerId,number>`, `waitingSince?: ReadonlyMap<PlayerId,number>`, `queueBy: 'games'|'wait'`, `random: () => number`, `requireFirstCourt: boolean`, `maxStates: number`; production passes **100,000**. Include court indexes so skipped courts cannot be renumbered accidentally.

- [x] **Step 1: Write failing tests:** both members sit/play as one in games-first and wait-only level queues; a pair is skipped for singles but remains eligible for a later doubles court; mixed formats fill the maximum legal seats without renumbering skipped courts; variety picks fewer repeat partners, balanced picks the smaller rating gap, and level prefers its band among otherwise legal results; 12-player constrained rounds use legal seeds/unit moves and never falsely claim impossibility; `searchLegalAssignments({...maxStates:1})` returns `{status:'limit'}` and `generateRound` maps inconclusive search to `PairRuleSearchLimitError`; both solo and multi-newcomer carry courts obey all three rules. Compare unconstrained seeded cases to their pre-change outputs and keep quality baselines.
- [x] **Step 2: Run red:** `node --experimental-strip-types --test engines/pair-rules.test.ts engines/pairing-quality.test.ts`. Expected FAIL for rule cases.
- [x] **Step 3: Add pair-unit selection, constrained legal seeding and unit-aware local moves** in `pairing.ts`; use complete enumeration for <=8 playing players, a 100,000-state feasibility bound above that, and retain existing score comparison only among legal candidates. Make the carry builder fall back to normal legal pairing if its special lineup cannot satisfy rules; do not change unlinked carry behavior.
- [x] **Step 4: Run green:** `npm run test:engines`. Expected PASS, including existing quality comparison.
- [x] **Step 5: Commit** only engine/test hunks: `git commit -m "feat(engine): plan legal courts around pair units"`.

### Task 5: Wire session lifecycle and linked carry outcomes

**Files:** Modify `server/src/sessions/sessions.service.ts`, `server/src/sessions/carry-eligibility.ts`, `server/src/sessions/carry-eligibility.spec.ts`, `server/src/sessions/sessions.controller.spec.ts`, `server/src/sessions/auto-confirm-due.spec.ts`, `server/src/groups/groups.service.ts`; create `server/src/sessions/carry-outcomes.ts`, `server/src/sessions/carry-outcomes.spec.ts`.

**Interfaces:** Consume Task 2 enabled/applicable rules and Task 3/4 engine signatures/errors. `CarryOutcome = {playerId:string;partnerId:string|null}`; `carryOutcomesForConfirm(teams: {teamA:string[];teamB:string[]}, linkedIds: ReadonlySet<string>, levels: ReadonlyMap<string, Level|null>, activeRosterIds: readonly string[]): CarryOutcome[]` snapshots whether the player is far-below now and the teammate strictly above, using active roster levels for `isFarBelow`. Extend `CarryInputs.confirmedPairingsTonight` with parsed `carryOutcomes`; legacy `[]` means existing any-game behavior. Write `Pairing.carryOutcomes` alongside confirmedAt, clear on undo confirm only. A blocked `propose` yields `{ok:false,reason:'pair-rules-blocked',ruleIds:string[]}`; fill-all includes `filled`, `blocked` court/rule IDs and `inconclusive` court numbers, with `ok:false` if none filled. Search-limit on one requested court returns `PAIR_RULE_SEARCH_LIMIT` (503), never "not enough players".

- [x] **Step 1: Write failing tests:** all engine-entry surfaces (`propose`, reshuffle, fill-all, custom auto-pair) load current group/session rules; partial fill-all lists filled and blocked/inconclusive courts without claiming all succeeded; manual seat/swap and confirm reject completed violations; a rule added just before auto-confirm blocks that pending court but not another; active matches continue; undo confirm rechecks current rules. Linked newcomer with unsuitable teammate stays eligible, with higher teammate is fulfilled once and only that teammate is "carried", with absent required partner may use another higher teammate, and a roster change making them far-below after an earlier null outcome does not retroactively fulfill carry. Malformed non-legacy outcome JSON fails visibly rather than marking a carry complete. Level retag and rule disable retain their specified behavior.
- [x] **Step 2: Run red:** `cd server && npx vitest run src/sessions/carry-outcomes.spec.ts src/sessions/carry-eligibility.spec.ts src/sessions/sessions.controller.spec.ts src/sessions/auto-confirm-due.spec.ts -t "pair rule|linked carry"`. Expected FAIL.
- [x] **Step 3: Implement snapshot helper and lifecycle integration**. Extend `pairingConfirmBlocker` for both manual/auto confirm; pass `'requested'` to single-court propose and `'partial'` to fill-all, map `NoLegalRuleMatchError` to a blocked-rule outcome and `PairRuleSearchLimitError` to an explicit inconclusive result; never use `not-enough-players` for either. Apply current group rules after session disables and availability; preserve `Pairing.revision`, locks, undo and group export.
- [x] **Step 4: Run green:** same targeted selector, `cd server && npm run build`, then `cd server && npx vitest run src/auth/auth.boundary.spec.ts`. Expected PASS.
- [x] **Step 5: Commit** only lifecycle, carry and export hunks: `git commit -m "feat(server): enforce pair rules and track linked carry"`.

### Task 6: Persistent rule editor on host roster

**Files:** Create `web/src/app/core/pair-rule.model.ts`; modify `web/src/app/core/roster.service.ts`, `web/src/app/core/roster.service.spec.ts`, `web/src/app/pages/player-roster/player-roster.{ts,html,css,spec.ts}`, `web/src/locale/messages.en.xlf` (source catalog if extraction changes it).

**Interfaces:** Consume Task 1 group rule endpoints; expose `RosterService.getRules(groupCode: string): Observable<PairRule[]>`, `createRule(groupCode: string, dto: {playerAId:string;playerBId:string;kind:RuleKind}): Observable<PairRule>`, `setRuleKind(groupCode: string, ruleId: string, kind: RuleKind): Observable<PairRule>`, `deleteRule(groupCode: string, ruleId: string): Observable<{deleted:boolean}>`. UI selects two existing group players and exactly one rule kind; `PairRule` in `web/src/app/core/pair-rule.model.ts` has `{id,groupId,playerAId,playerBId,kind,createdAt:string}`, plus the `RuleKind` union.

- [x] **Step 1: Write failing web tests:** create, switch kind, remove, and render each of the three Thai labels; show errors for duplicate/conflicting pairs without clearing selection; do not allow choosing one player twice; no rule editor appears on public player views. Verify keyboard-accessible 44px controls.
- [x] **Step 2: Run red:** `cd web && npx ng test --watch=false --include=src/app/core/roster.service.spec.ts --include=src/app/pages/player-roster/player-roster.spec.ts`. Expected FAIL.
- [x] **Step 3: Add typed transport and inline host editor** to the existing player roster; share `RuleKind` in `web/src/app/core/pair-rule.model.ts` rather than importing engine implementation into the public UI. Add English translations for new Thai labels and error strings.
- [x] **Step 4: Run green:** same `ng test --include` selectors. Expected PASS.
- [x] **Step 5: Commit** only roster/editor/model/locale hunks: `git commit -m "feat(web): edit group pair rules"`.

### Task 7: Session switches, conflict UX, docs

**Files:** Modify `web/src/app/core/live-session.service.{ts,spec.ts}`, `web/src/app/pages/session-dashboard/session-dashboard.{ts,html,css,spec.ts}`, `web/src/app/pages/session-dashboard/court-panel/court-panel.{ts,html,css,spec.ts}`, `web/src/locale/messages.en.xlf`, `docs/overview.md`, `docs/2026-09-27-real-host-feedback.md`.

**Interfaces:** Consume Task 2 `GET /sessions/:code/rules`, `POST /sessions/:code/rules/:ruleId/toggle`; Task 5 stable blocked/violation/search-limit codes. Produce `LiveSessionService.getSessionRules(): Promise<{rules: PairRule[];disabledRuleIds: string[]}>` and `toggleSessionRule(ruleId: string, enabled: boolean): Promise<ActionResult>`; session rule state stays host-only and separate from public polling.

- [x] **Step 1: Write failing UI tests:** disable one group rule for tonight and re-enable without changing the group default; a rule added from another tab appears after the dashboard's ordinary refresh/focus; explain blocked proposal with relevant players/rules; show conflicting pending lineup and let the host fix it, never present it as auto-confirmable; tell search-limit apart from true "not enough players"; active match remains visible when a rule changes; public display sees no rules.
- [x] **Step 2: Run red:** `cd web && npx ng test --watch=false --include=src/app/core/live-session.service.spec.ts --include=src/app/pages/session-dashboard/session-dashboard.spec.ts --include=src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`. Expected FAIL.
- [x] **Step 3: Implement session controls and localized errors** using host-only resource/action handling; refresh the separate rules resource on successful toggles and the dashboard's existing 30-second/focus refresh, never by adding rules to public session polling. Keep pairing/team IDs and court positions numeric, 44px targets and errors visible on the relevant court. Update English XLF; inspect extraction diff before staging source catalog.
- [x] **Step 4: Run green and build:** same web selectors; `cd web && npm run build`; `cd server && npm run lint && npm run build`; `npm run test:engines`. Expected PASS. Run server targeted specs if an interaction changed after Task 5.
- [x] **Step 5: Document only shipped behavior** in `docs/overview.md`; mark feedback C `- [x]` with a done note in `docs/2026-09-27-real-host-feedback.md`. Keep the backlog live with A, D, E, F still open.
- [x] **Step 6: Commit** only feature-owned UI, translation and doc hunks: `git commit -m "feat: make pair rules actionable for hosts"`. If the feedback file remains untracked, ask before staging its entire existing content; never include unrelated worktree changes.

At execution, read the spec and preserve the existing dirty worktree; selectively stage feature-owned hunks. A, D, E, and F are separate plans, not prerequisites to implementing C except the already shipped B behavior. Do not check off any plan step before its code/test/commit exists.
