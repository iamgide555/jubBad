# Group creation and discoverable settings

## Status and purpose

- **Design direction:** approved in conversation; written spec awaiting review.
- **Audience:** badminton hosts creating and managing groups, primarily on phones.
- **Outcome:** a host can save a group using only its name, access every group setting immediately, and start the first session later.
- **Primary UX decision:** the labelled settings button stays beside the group name, above the session action. Expanded settings also remain above the session action.
- **Prototype reference:** `.superpowers/brainstorm/73498-1791899054/content/group-settings-prototype.html` illustrates the approved flow. It is disposable demo code, not application implementation.

---

## Approved flow

### Create a group

- **Entry:** the existing **สร้างก๊วนใหม่** action opens a dedicated name-only creation form at `/groups/new`.
- **Required input:** **ชื่อก๊วน**, trimmed and nonempty. Use an empty input with an example placeholder in production; the prototype's prefilled name is sample data.
- **Submit:** **สร้างก๊วน** persists an owned group immediately, with existing default settings and no session or players.
- **Success:** navigate to `/g/:groupCode`, showing the saved group name and access to settings.
- **Leave and return:** a saved group with no sessions appears in the existing group list and can be reopened. Starting a session is optional.
- **Cancel:** provide a return to the group list before submission; no group is created merely by opening the form.

### Group home and settings

1. **Header:** group name with a gear icon and visible **ตั้งค่าก๊วน** label alongside it.
2. **New-group hint:** explain that player levels and group options are available in settings. Show while the group has no sessions; it is informational, not a completion checklist.
3. **Settings disclosure:** closed initially; tapping the labelled button reveals the options directly below the header.
4. **Session action:** **เริ่มรอบแรก** for a group without sessions, positioned below settings. No roster form is shown until the host chooses to start a session.
5. **Existing activity:** for returning hosts, retain **กลับไปรอบล่าสุด**, **เริ่มรอบใหม่**, and past-session access below the header/settings area. The settings location does not change as history grows.

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
- **Management separation:** visually separate the fifth row from routine settings. Within management, keep deletion below rename/export and preserve the existing typed-name confirmation.
- **Player preparation:** an empty player-management screen explains that players can be added when starting a session. This work does not introduce a separate player-import or standalone player-creation feature.
- **Level preparation:** the level editor is usable before the first session exists. Preserve standard/custom ladder behavior and restrictions while a session is open.
- **Advanced settings:** load and save before any roster entry. Preserve existing defaults and the explanation that changes apply to subsequently created sessions.
- **Sharing:** retain existing explicit activation and revocation. Show **ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้** near the enable action, plus existing information about the shared summary. Do not enable sharing automatically.
- **Detail context:** retain the group name on settings detail views and a clear path back to the same group. Returning from a detail restores the open settings disclosure and focus to its originating row.

### Start a session

- **Entry:** **เริ่มรอบแรก** or **เริ่มรอบใหม่** opens the existing roster-entry workflow for the already saved group.
- **Alternatives:** retain LINE-message import and **เพิ่มรายชื่อเอง**.
- **Review and confirmation:** preserve roster matching, manual additions, level selection, session details, and the existing explicit roster-confirmation step.
- **Settings timing:** the first session uses the group's saved settings through the existing session-creation behavior.
- **Return:** provide a clear return to group home. Browser Back follows the visible journey; it does not unexpectedly leave the application or create a new group.

---

## Architecture and data flow

### Server responsibilities

- **Dedicated creation:** add an authenticated `POST /groups` operation accepting a client-generated group code and name. The client allocates one full UUID per creation attempt and reuses it for retries.
- **Ownership:** associate the new group with the authenticated caller. Never accept an owner supplied in the request body.
- **Retry behavior:** repeating creation for the same code and owner returns the existing group without renaming it or resetting its settings. Atomic create-or-read behavior prevents duplicate groups from double taps or a lost response.
- **Collision behavior:** a code belonging to another owner cannot be claimed or modified; preserve the application's not-found response convention. The dedicated creation operation must not treat an administrator's retry as permission to overwrite another group's data.
- **Validation:** reject a missing/blank name and malformed new-group code. Existing groups and legacy codes retain their current read/update behavior.
- **Storage:** use the existing `Group` fields and defaults. No onboarding-progress field, placeholder session, or schema migration is required for this design.
- **Compatibility:** preserve the current parse endpoint's legacy create-or-own behavior for older clients during this change. The updated UI always saves the group before reaching roster entry.
- **Shared behavior:** keep the ownership/create primitive small and reusable where appropriate; preserve existing authorization and race protections when consolidating code.

### Client responsibilities

- **Creation form:** owns name validation, one stable creation code, in-flight state, and retry. Add the API method to the existing roster/group service.
- **Group home:** owns saved-group loading, the header/settings disclosure, activity links, and the transition to roster entry. A missing group is an explicit not-found state; a failed request is a retryable error, never silently interpreted as a new group.
- **Roster entry:** reuses the existing parsing and confirmation implementation. Manual entry no longer needs to call the parser with empty text solely to create a group.
- **Settings reuse:** reuse the existing player and level routes, share panel, name-update API, advanced-setting APIs, export, and deletion logic. Extract settings presentation from the oversized entry template only where it gives these views a clear responsibility.
- **Routing:** keep `/g/:groupCode` as group home. Use `/g/:groupCode/start` for roster entry and `/g/:groupCode/settings/:section` for the `share`, `advanced`, and `manage` detail views; keep existing player/level URLs. All new host routes retain the existing authentication guard.
- **Back and drafts:** preserve an entered roster when returning from settings within the same editing journey; use existing unsaved-change protection where navigation would discard edits. Do not persist application data in browser local storage.

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

---

## Boundaries

- **Included:** real name-only group creation, discoverable top settings, optional first-session entry, existing feature access, rename preservation, and sharing-scope copy.
- **Excluded:** setup wizard, required onboarding checklist, new player-import tooling, matchmaking/rating changes, revised billing behavior, broad restyling, pricing changes, deployment, or publication.
- **Existing data:** current groups, ownership, players, sessions, public links, and historical results retain their behavior. No migration of historical records is needed.
- **Prototype limitations:** mock parsing, sharing, export, and persistence are illustrative; production implementation must use the existing real operations rather than copy their simulated responses.

---

## Acceptance and validation

- [ ] **Creation:** a host saves a named group without a LINE message, player, or session; it survives reload and appears in the group list.
- [ ] **Retry and authorization:** repeated creation yields one owned group; cross-owner attempts cannot read or alter another group's settings through creation.
- [ ] **Discovery:** settings is visible beside the group name on initial load and stays above session actions and history for new and existing groups.
- [ ] **Disclosure:** all five options open from the top control; closing and returning from detail views preserve predictable focus and navigation.
- [ ] **Preparation:** levels and advanced settings can be saved before the first session; defaults allow immediate continuation.
- [ ] **Preservation:** renaming, players, levels, sharing/revocation, export, typed-name deletion, latest-session access, and history remain available.
- [ ] **Session flow:** LINE and manual paths create sessions for the saved group and retain existing roster review, validation, and settings behavior.
- [ ] **Error states:** failed saves preserve inputs; network failures are distinguishable from absent groups; unavailable settings are not reported as successfully loaded.
- [ ] **Presentation:** verify at 375px and desktop, long Thai/English names, both themes, keyboard navigation, and reduced motion. Opening settings is allowed to move the session action below the fold.
- [ ] **Checks:** run focused server creation/ownership tests and Angular creation/navigation/settings tests, then relevant existing group/roster regressions and the bilingual production build. Engine tests are only needed if engine-related code changes unexpectedly become necessary.

## Spec self-review

- **Scope check:** the work separates group creation from session entry and preserves existing feature behavior.
- **Ordering check:** the final user decision supersedes the critique's suggestion to place the session action above expanded settings.
- **Consistency check:** the group is saved before setup and roster entry; optional settings never gate session creation; backend compatibility does not reintroduce the old UI flow.
- **Completion check:** no unresolved product decision or placeholder requirement remains; acceptance items intentionally stay unchecked until implementation is verified.
