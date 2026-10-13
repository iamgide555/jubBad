# Group creation and discoverable settings

## Status and purpose

- **Design direction:** approved in conversation; written spec awaiting review.
- **Audience:** badminton hosts creating and managing groups, primarily on phones.
- **Outcome:** a host can save a group using only its name, access every group setting immediately, and start the first session later.
- **Primary UX decision:** the labelled settings button stays beside the group name, above the session action. Expanded settings also remain above the session action.
- **Prototype reference:** `.superpowers/brainstorm/73498-1791899054/content/group-settings-prototype.html` illustrates the approved flow. It is disposable demo code, not application implementation. `.superpowers/` is gitignored, so the prototype exists only on the authoring machine; this spec, not the prototype, is the shared reference.

---

## Approved flow

### Create a group

- **Entry:** the existing **สร้างก๊วนใหม่** action opens a dedicated name-only creation form at `/groups/new`.
- **Required input:** **ชื่อก๊วน**, trimmed and nonempty. Use an empty input with an example placeholder in production; the prototype's prefilled name is sample data. No maximum length is introduced (rename has none today); long names are a layout concern, covered under States.
- **Submit:** **สร้างก๊วน** persists an owned group immediately, with existing default settings and no session or players.
- **Success:** navigate to `/g/:groupCode`, showing the saved group name and access to settings.
- **Leave and return:** a saved group with no sessions appears in the existing group list and can be reopened. Starting a session is optional.
- **Cancel:** provide a return to the group list before submission; no group is created merely by opening the form.
- **Same-name warning (decided 2026-10-13):** if the host already owns a group with the same name (trimmed, whitespace-collapsed, case-insensitive), the first submit does not create. It shows a non-blocking note, **คุณมีก๊วนชื่อนี้อยู่แล้ว**, with a link to open the existing group. Submitting again with the same name creates the new group anyway, since one host may genuinely run two same-named groups. Editing the name clears the note. The check is against the caller's own groups only (`GET /groups` is already owner-filtered; an admin's other-host rows are ignored). Other hosts' names are never checked, since that would reveal their groups. It is a client-side courtesy, not a server rule: if the list cannot be read, creation proceeds without the check. Renaming in **จัดการก๊วน** applies the same warning, excluding the group being renamed.

### Group home and settings

1. **Header:** group name with a gear icon and visible **ตั้งค่าก๊วน** label alongside it.
2. **New-group hint:** one line that confirms the save and points at settings, for example **บันทึกก๊วนแล้ว เริ่มรอบได้ทันที ระดับผู้เล่นและตัวเลือกอื่นอยู่ใน “ตั้งค่าก๊วน”**. Show it while the group has no sessions. It is informational, not a completion checklist, and it is the only "ready" message on the page; no second "your group is ready" heading goes above the session action.
3. **Settings disclosure:** closed initially; tapping the labelled button reveals the options directly below the header.
4. **Session action:** **เริ่มรอบแรก** for a group without sessions, positioned below settings. No roster form is shown until the host chooses to start a session.
5. **Existing activity:** for returning hosts, retain **เริ่มรอบใหม่** and past-session access below the header/settings area. The settings location does not change as history grows.
6. **Header resume link:** when the group has a latest session, a compact **กลับไปรอบล่าสุด** link sits in the header block, directly under the name/settings row and above the disclosure. Because it is above the disclosure, it stays on screen however far expanded settings pushes the session actions down, including when a host returns from a settings detail with the disclosure reopened. It is a text link in `--court-ink` (ordinary navigation), not a filled button, so it never competes with the primary session action. The 44px target comes from padding, not from visual weight. It is the only copy of that link on the page; the old full-width resume button is not duplicated below.

- **Opening behavior:** settings expands inline. It is not an automatic popup, a modal, a mandatory setup step, or a separate onboarding wizard.
- **Confirmed ordering:** expanding settings may move the session action down. This is intentional; the host has chosen to inspect settings. Do not move the session action above the settings options to address that displacement.
- **Closing behavior:** tapping the settings button again collapses the options; Escape closes the disclosure and returns focus to its trigger.
- **No completion gate:** defaults are usable. Hosts never need to visit every setting, add players in advance, or generate a share link to start a session.

### Settings contents

| Order | Label | Destination and behavior |
|---|---|---|
| 1 | **จัดการผู้เล่น** | Existing group player-management screen at `/g/:groupCode/players` |
| 2 | **ระดับผู้เล่นของก๊วน** | Existing level editor at `/g/:groupCode/levels` |
| 3 | **แชร์หน้าสรุปก๊วน** | Existing share controls, including link creation, copy, and disabling sharing |
| 4 | **ตั้งค่าขั้นสูง** | Existing numbered-shuttle and cross-session-history settings |
| 5 | **จัดการก๊วน** | Existing group-name editing, export, and deletion controls |

- **Descriptions:** give each row a short explanation of its contents. The management description includes **ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน**.
- **Live values:** rows 1–4 show the group's current state on a second line, so opening settings doubles as a status check. Row 1 shows `N คน`; row 2 shows **มาตรฐาน** or **กำหนดเอง · N ระดับ**; row 3 shows **แชร์อยู่** or **ยังไม่แชร์**; row 4 shows **ปิดทั้งหมด**, **เปิด 1 จาก 2**, or **เปิดทั้งหมด**, while its description names both options. Each value is a small pill beside the row title: neutral (`--ground-sunk`) by default, `--court-soft` with `--court-ink` text when something is switched on (custom ladder, sharing, an advanced option). Values are fetched when the disclosure first opens, using the existing owner-only endpoints. They are never added to the public `GET /groups/:code`. While loading, and if a fetch fails, the row shows its static description only; it never shows a guessed default as if it were loaded. Row 5 has no value.
- **Row semantics:** rows are links (`routerLink`), not buttons, because each one navigates. The title is the accessible name, and the description and value are attached with `aria-describedby`. Concatenating them into one name produces a single unbroken run in Thai, which has no word spaces. The list's container is labelled differently from the trigger (for example **ตัวเลือกของก๊วน**) so a screen reader doesn't announce the same name twice.
- **Management separation:** visually separate the fifth row from routine settings. Within management, keep deletion below rename/export and preserve the existing typed-name confirmation.
- **Player preparation:** an empty player-management screen explains that players can be added when starting a session. This work does not introduce a separate player-import or standalone player-creation feature.
- **Level preparation:** the level editor is usable before the first session exists. Preserve standard/custom ladder behavior and restrictions while a session is open.
- **Advanced settings:** load and save before any roster entry. Preserve existing defaults and the explanation that changes apply to subsequently created sessions.
- **Sharing:** retain existing explicit activation and revocation. Show **ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้** near the enable action, plus existing information about the shared summary. Do not enable sharing automatically.
- **Detail context:** retain the group name on settings detail views and a clear path back to the same group. Returning from a detail restores the open settings disclosure and focus to its originating row.
- **Return mechanism:** every settings detail's back link targets `/g/:groupCode?settings=<section>`, where `<section>` is `players`, `levels`, `share`, `advanced`, or `manage`. This includes changing the existing back links in `player-roster.html` and `group-levels.html`, which currently target plain `/g/:groupCode`. On load, group home reads the parameter, opens the disclosure, focuses the row whose section matches, then removes the parameter with a `replaceUrl` navigation so a reload or Back does not reopen settings. An unknown section value opens the disclosure without moving focus. Browser Back from a detail (not the in-page link) lands on the URL the host came from; if that was plain `/g/:groupCode`, settings starts closed. This is accepted rather than worked around.

### Start a session

- **Entry:** **เริ่มรอบแรก** or **เริ่มรอบใหม่** opens the existing roster-entry workflow for the already saved group.
- **Alternatives:** retain LINE-message import and **เพิ่มรายชื่อเอง**.
- **Review and confirmation:** preserve roster matching, manual additions, level selection, session details, and the existing explicit roster-confirmation step.
- **Settings timing:** the first session uses the group's saved settings through the existing session-creation behavior.
- **Return:** provide a clear return to group home. Browser Back follows the visible journey; it does not unexpectedly leave the application or create a new group.
- **No settings shortcut from roster entry:** `/g/:groupCode/start` shows the group name and a back link to group home, but does not render the settings list itself. Level selection during roster review stays inline, as it is today. A host who needs a setting mid-roster goes back to group home, opens settings, and comes back; the draft rule below keeps their work.

---

## Architecture and data flow

### Server responsibilities

- **Dedicated creation:** add an authenticated `POST /groups` operation accepting a client-generated group code and name. The client allocates one full UUID per creation attempt and reuses it for retries.
- **Ownership:** associate the new group with the authenticated caller. Never accept an owner supplied in the request body.
- **Retry behavior:** repeating creation for the same code and owner returns the existing group without renaming it or resetting its settings. Atomic create-or-read behavior prevents duplicate groups from double taps or a lost response.
- **Collision behavior:** a code belonging to another owner cannot be claimed or modified; preserve the application's not-found response convention. The dedicated creation operation must not treat an administrator's retry as permission to overwrite another group's data. This differs deliberately from `GroupsService.parse`, which lets an admin through on a foreign code; creation checks `ownerId === caller.id` strictly, with no admin exception.
- **Guard path:** `OwnershipGuard` already passes every method on the exact path `/groups` (that is how `GET /groups` reaches its owner-filtered list), so `POST /groups` reaches the service unchecked by the guard. The ownership decision for creation lives entirely in the service, next to the atomic create-or-read, and the guard comment listing what `/groups` covers must be updated to name `POST` too.
- **Code format:** a new group code is a full lowercase canonical UUID (36 characters, as produced by `crypto.randomUUID()`). Legacy 8-hex codes, minted today by `landing.ts` as `randomUUID().slice(0, 8)`, stay valid everywhere they are read; only `POST /groups` enforces the new format. The longer code is what makes reusing one code across retries safe: with 32 bits, a clash with another host's group would make every retry of that code fail.
- **Validation:** reject a missing/blank name and malformed new-group code. Existing groups and legacy codes retain their current read/update behavior.
- **Blank-name enforcement:** `@MinLength(1)` alone accepts `"   "`. The creation DTO trims with class-transformer's `@Transform` before validating (the global `ValidationPipe` already runs with `transform: true`), and stores the trimmed name. Apply the same trim to `UpdateGroupDto` so rename and creation accept and store names identically; `ParseRosterDto.groupName` is left alone as legacy-compatibility surface.
- **Storage:** use the existing `Group` fields and defaults. No onboarding-progress field, placeholder session, or schema migration is required for this design.
- **Compatibility:** preserve the current parse endpoint's legacy create-or-own behavior for older clients during this change. The updated UI always saves the group before reaching roster entry.
- **Shared behavior:** keep the ownership/create primitive small and reusable where appropriate; preserve existing authorization and race protections when consolidating code.

### Client responsibilities

- **Creation form:** owns name validation, one stable creation code, in-flight state, and retry. Add the API method to the existing roster/group service. The code is reused only across retries of a transport failure or 5xx. A 404 from creation means the code is unusable for this caller; the form discards it, allocates a fresh UUID, and reports a generic failure the host can retry, so it never gets stuck retrying a dead code.
- **Group home:** owns saved-group loading, the header/settings disclosure, activity links, and the transition to roster entry. A missing group is an explicit not-found state; a failed request is a retryable error, never silently interpreted as a new group.
- **Roster entry:** reuses the existing parsing and confirmation implementation. Manual entry no longer needs to call the parser with empty text solely to create a group.
- **Settings reuse:** reuse the existing player and level routes, share panel, name-update API, advanced-setting APIs, export, and deletion logic. Extract settings presentation from the oversized entry template only where it gives these views a clear responsibility.
- **Routing:** keep `/g/:groupCode` as group home. Use `/g/:groupCode/start` for roster entry and `/g/:groupCode/settings/:section` for the `share`, `advanced`, and `manage` detail views; keep existing player/level URLs. All new host routes retain the existing authentication guard.
- **Back and drafts:** preserve an entered roster when returning from settings within the same editing journey. Do not persist application data in browser local storage.
- **Draft mechanism:** `/start` and the settings routes are separate route components, so the roster component is destroyed on navigation and cannot hold the draft itself. Add a root-provided, in-memory `RosterDraftService` keyed by group code. It holds the pasted text, the parse result, and the host's review decisions and manual additions. `/start` restores from it on entry and writes to it when the screen is left (the component's destroy hook), which is the only moment a draft can be lost. It is cleared when a session is created from the draft or the host explicitly discards it. A full page reload or closing the tab loses the draft, which matches today's group-entry behavior (that route has no `canDeactivate` now). No new unsaved-change prompt is added for in-app navigation, since in-app navigation no longer discards anything.

---

## States, copy, and visual constraints

- **Creation pending:** disable duplicate submission and show **กำลังสร้างก๊วน...**; navigate only after the saved-group response.
- **Creation failure:** keep the entered name and creation code, explain the failure, and offer retry. A retry must not create a second group.
- **Settings load/save failure:** use the existing visible retry/error treatment; retain last confirmed values and do not silently present defaults as loaded settings.
- **Long names:** allow the heading to wrap without pushing settings off-screen or shrinking its touch target.
- **Accessibility:** use a native disclosure button with `aria-expanded` and `aria-controls`, 44px minimum targets, visible focus, labelled fields, appropriate live feedback, and coherent focus restoration.
- **Theme and type:** preserve the shipped Daylight Court tokens, Thai-capable fonts, and light/dark behavior. Use the existing type scale rather than copying the mockup's ad hoc sizes.
- **Motion:** preserve reduced-motion support and existing interaction conventions; settings does not require decorative animation.
- **Localization:** update Thai source messages and English translations for all new or revised interface copy. Prototype explanation text does not ship as application content.
- **Feedback colors:** validation failures use existing error semantics rather than the prototype's green status treatment.
- **Validation display:** an empty name shows the existing inline `.error` with `role="alert"` under the field and reuses the existing **กรุณาใส่ชื่อก๊วนก่อน** string (`@@entry.errNoGroupName`), not the browser's transient `reportValidity` bubble.
- **Built from shipped primitives:** implement with the classes and tokens in `web/src/styles.css`, not with the prototype's own control layer. That means the default `button` (filled `--court`, weight 700, `--shadow-xs`), `button.ghost` (1.5px `--line` border), `button.danger` (filled `--warn`), disabled as `--line` fill with `--ink-faint` text, hover only inside `@media (hover: hover)`, the global `:focus-visible` ring, `.label`, `.muted`, `.error`, `.scope-toggle` for any segmented choice, `appPress` on tappable rows, and `appReveal` for the disclosure's entry. Headings use the display face on the shipped scale (`--text-xl` and up, line-height 1.25). Inputs use a 1.5px border.
- **Danger zone:** the management detail keeps the incumbent's dashed `--warn` danger-zone treatment (`group-entry.css`) around deletion, including the typed-name confirmation.
- **Shell:** settings views render inside the existing app shell bar, which keeps the theme toggle. No in-page wordmark is added; PRODUCT.md keeps the product name to the login screen.

### Prototype deviations implementers must not copy

The prototype contradicts this spec in the following places. The spec wins in each case.

| Prototype | Spec |
|---|---|
| Default button is white with a 1px border; filled needs `.primary` | Default `button` is filled `--court`; `.primary` does not exist in the app |
| `.danger` is red text; delete is a disabled stub | Filled `button.danger` behind the typed-name confirmation |
| 3px green focus outline; green caret; custom selection colour | Global `:focus-visible` ring, caret, and selection from `styles.css` |
| Light only (`color-scheme: light`) | Light and dark through the shipped tokens |
| No cancel on create; `maxlength="80"`; no pending state | Cancel back to the group list; no maximum length; **กำลังสร้างก๊วน...** while saving |
| Native `reportValidity` bubble | Inline `.error` with `role="alert"` |
| Management description omits ชื่อก๊วน; no rename | **ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน**, with rename first |
| Hint always visible | Hint only while the group has no sessions |
| Manual entry is a separate mode with a per-name add field | Existing paste box with two peer actions; manual entry lands on the confirm step |
| `P−` (Unicode minus) in the level ladder | `P-`, as in `engines/levels.ts` |
| "นับประวัติคู่ข้ามรอบ" with a one-sided hint | Keep the on/off contrast: **ปิด: เลี่ยงคู่ซ้ำเฉพาะคืนนี้ · เปิด: นับทุกรอบที่ผ่านมา** |

---

## Vocabulary: ก๊วน is the group, รอบ is the session

Shipped copy uses ก๊วน for both the reusable group and a single night ("จบก๊วน", "ก๊วนที่ผ่านมา"), and the landing page counts sessions as นัด. This flow introduces ก๊วน = group and รอบ = session. Shipping it without a sweep would leave **ลบก๊วน** (delete the group, irreversible) sharing its noun with **จบก๊วน** (end tonight). The decision, made 2026-10-13, is to sweep the whole app in this change.

- **Rule:** ก๊วน names only the reusable group: its name, players, levels, settings, deletion, and owner. รอบ names one session: ending it, its summary, its bill, its display, its history, and its errors. นัด is retired; `home.sessionsSuffix` becomes `รอบ`.
- **Session-meaning strings to change** (Thai source; check English for the same group/session confusion). This list is a seed taken from a grep, not an exhaustive one:
  - **Display, dashboard, court:** `display.sessionEnded`, `display.notFound`, `dashboard.sessionEnded`, `dashboard.endSession`, `dashboard.copySummaryLink`, `dashboard.notFound`, `dashboard.notFoundHint2`, `court.sessionEnded`.
  - **Summary:** `summary.title`, `summary.noMatches`, `summary.notFound`.
  - **Bill and checkout:** `bill.backLive`, `bill.back`, `bill.prefilled`, `bill.warnUnknownUse`, `bill.settledHint`, `checkout.ratesHint`, `checkout.err.unknownUse`, `checkout.err.disabled`, `checkout.err.ended`.
  - **Errors and levels:** `err.code.sessionEnded`, `err.code.sessionNotFound`, `err.code.invalidSessionState`, `err.code.rosterPlayerNotFound`, `err.code.rosterDuplicate`, `err.code.shuttleTrackingDisabled`, `err.endSession`, `levels.err.activeSession`.
  - **Group dashboard, entry, walk-in, home:** the public group dashboard's empty-state and past-sessions strings, `entry.pastSessions`, `entry.advancedHint`, `entry.crossSessionHistory`, `entry.crossSessionHistoryHint`, `walkIn.alreadyOnRoster`, and `home.removeWarning`'s "ก๊วนย้อนหลัง".
- **Group-meaning strings stay.** Examples: `home.*` titles, `levels.*` titles, `playerRoster.title`, `share.*`, `entry.groupName`, `entry.manageGroup`, the delete strings, `addRule.persistHint`, `profile.partnersLast30Days`, and the `admin.*` group columns.
- **Idiom check:** `bill.hostFee` (**ค่าจัดก๊วนต่อคน**) and `admin.roleHost` (**ผู้ดูแลก๊วน**) are established idioms for the host's fee and role. Keep them unless the owner says otherwise; they do not name a single night.
- **Obsolete after this flow:** `entry.advancedUnavailable` and `share.unavailable` ("only after the first group is created") can no longer occur once the group is saved before settings. Remove them rather than reword them.
- **Mechanics:** the Thai text is the i18n source, so edit templates and `$localize` calls, then regenerate `messages.xlf` with the existing extract step and update `messages.en.xlf`. Spec files that match Thai text with `textContent` need updating in the same change. Server-side Thai strings (`server/src/admin/admin.service.ts`) follow the same rule.

## Boundaries

- **Included:** real name-only group creation, discoverable top settings, optional first-session entry, existing feature access, rename preservation, sharing-scope copy, and the app-wide ก๊วน/รอบ vocabulary sweep below.
- **Excluded:** setup wizard, required onboarding checklist, new player-import tooling, matchmaking/rating changes, revised billing behavior, broad restyling, pricing changes, deployment, or publication.
- **Existing data:** current groups, ownership, players, sessions, public links, and historical results retain their behavior. No migration of historical records is needed.
- **Prototype limitations:** mock parsing, sharing, export, and persistence are illustrative; production implementation must use the existing real operations rather than copy their simulated responses.

---

## Acceptance and validation

- [ ] **Creation:** a host saves a named group without a LINE message, player, or session; it survives reload and appears in the group list. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Same-name warning:** creating or renaming to a name the host already uses warns once with a link to the existing group, then proceeds on a second submit. Another host's identical name never triggers it, and a failed list read never blocks creation. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [x] **Retry and authorization:** repeated creation yields one owned group; cross-owner attempts cannot read or alter another group's settings through creation.
- [ ] **Discovery:** settings is visible beside the group name on initial load and stays above session actions and history for new and existing groups. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Disclosure:** all five options open from the top control; closing and returning from detail views preserve predictable focus and navigation. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Preparation:** levels and advanced settings can be saved before the first session; defaults allow immediate continuation. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Preservation:** renaming, players, levels, sharing/revocation, export, typed-name deletion, latest-session access, and history remain available. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Session flow:** LINE and manual paths create sessions for the saved group and retain existing roster review, validation, and settings behavior. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Error states:** failed saves preserve inputs; network failures are distinguishable from absent groups; unavailable settings are not reported as successfully loaded. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Presentation:** verify at 375px and desktop, long Thai/English names, both themes, keyboard navigation, and reduced motion. Opening settings is allowed to move the session action below the fold. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [x] **Boundary coverage:** `server/src/auth/auth.boundary.spec.ts` covers `POST /groups` (401 without a cookie; a second host gets 404 on the first host's code; an admin gets 404 on a foreign code through creation). `web/src/app/app.routes.spec.ts` classifies `/groups/new`, `/g/:groupCode/start`, and `/g/:groupCode/settings/:section` as guarded, as the header comment in `app.routes.ts` requires for every new route.
- [x] **Blank and format validation:** `POST /groups` and `PUT /groups/:code` both reject a whitespace-only name and store a trimmed one; `POST /groups` rejects an 8-hex or otherwise malformed code, while legacy 8-hex groups still load, rename, and start sessions.
- [ ] **Draft survives settings:** a roster pasted on `/start`, followed by a trip to group home → settings → levels and back, is still on `/start`; creating the session clears it. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Return focus:** each settings detail's back link reopens the disclosure focused on its own row, and the `settings` query parameter is gone from the URL afterward. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Vocabulary:** no remaining Thai UI string uses ก๊วน for a single session, or นัด at all, outside the idioms listed above; Thai and English builds both pass. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Header resume:** a group with a latest session shows **กลับไปรอบล่าสุด** above the disclosure, still visible at 375px with settings expanded and after returning from a settings detail. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [ ] **Live values:** each of rows 1–4 shows its real value after the disclosure opens, its static description while loading or after a failed fetch, and nothing new appears in the public `GET /groups/:code` response. (unverified 2026-10-13: browser walkthrough blocked, the dev-DB admin rejects the `server/.env` credentials with 401)
- [x] **Checks:** run focused server creation/ownership tests and Angular creation/navigation/settings tests, then relevant existing group/roster regressions and the bilingual production build. Engine tests are only needed if engine-related code changes unexpectedly become necessary. (2026-10-13: engines 386, server 64 files/831, web 44 files/813 all pass; server lint clean; bilingual `web` build succeeds.)

## Spec self-review

- **Scope check:** the work separates group creation from session entry and preserves existing feature behavior.
- **Ordering check:** the final user decision supersedes the critique's suggestion to place the session action above expanded settings.
- **Consistency check:** the group is saved before setup and roster entry; optional settings never gate session creation; backend compatibility does not reintroduce the old UI flow.
- **Completion check:** no unresolved product decision or placeholder requirement remains; acceptance items intentionally stay unchecked until implementation is verified.
- **Critique patch (2026-10-13):** a second design critique (`.impeccable/critique/`, 22/40) found that the prototype's control layer contradicts the shipped design system, and that ก๊วน had two meanings. The owner chose an app-wide vocabulary sweep, a header resume link (kept above the disclosure, so the approved settings-above-actions order is unchanged), live row values, and fixing both the spec and the prototype.
- **Review patch (2026-10-13):** the first draft named three behaviours with no mechanism behind them (roster draft across routes, return-to-row focus, blank-name rejection) and left route-boundary tests out. The Return mechanism, Draft mechanism, Code format, Blank-name enforcement, and Guard path entries, plus the matching acceptance items, close those gaps without changing any approved UX decision.
