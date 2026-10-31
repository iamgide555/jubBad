# Payment Calculation Method Plan

**Approved design:** payment modal edits only calculation method. Fees remain read-only; missing inputs and zero totals lead to bill settings. Existing receiving-account behavior stays intact.

**Architecture:** add owner-only `POST /sessions/:code/bill-method` accepting only `model`, preserving all other inputs under session lock and invalidating payment confirmation on a method change. Reuse `GET /bill` for read-only method/rate display. No schema change or LINE-card content change.

---

## Tasks

- [x] **Server:** test real-app DTO validation, owner access, method-only preservation, unsupported advanced method and payment confirmation invalidation; implement narrow update.
- [x] **Calculation component:** show current/inherited method, supported-method selector and model-specific read-only rates; guarded save/error/loading states; use existing bill API data.
- [x] **Integration:** block payment actions during method update; re-read payment amounts afterward; refresh bill page data after changes; offer settings navigation for missing/zero states.
- [x] **Bill navigation:** summary opens bill settings; same-page bill action closes modal and focuses settings. Retain account drafts.
- [x] **Locales/docs:** append Thai/English units, update overview, record verification.
- [x] **Verification:** regressions before fixes, focused/full suites, TypeScript/lint, localized builds, phone/desktop/dark/English and missing/zero states, final review.

---

## Acceptance

- **Saved values:** method update never changes rates, session shuttle data, player flags or overrides.
- **Confirmation:** every actual method change revokes old confirmation/share link; failed/no-op updates preserve state.
- **Supported models:** ordinary sessions show three methods; shuttle-tracked sessions also show `perShuttle`.
- **No calculation editing:** modal contains method selector and read-only details; numeric calculation inputs stay on bill page.
- **Blocked totals:** missing inputs or all-zero dues never expose confirm/send; provide clear bill-settings action.
- **Release boundary:** local branch only; no merge or deployment during implementation.

---

## Verification results

- **Server:** 1,455 tests passed across 99 files; production TypeScript and oxlint passed. New DTO exercised through the real app; isolated temporary SQLite database only.
- **Web:** 1,669 tests passed across 71 files, one existing todo. Method selector component has 13 focused checks, including lost-response recovery and stale-session responses.
- **Regression evidence:** new method endpoint failed before implementation; integration tests failed before wiring; closing-pending regression failed when keepalive was removed and passed after restoring it.
- **Builds:** production Thai/English and localized development builds passed. Existing dashboard CSS and LIFF CommonJS warnings remain.
- **Browser:** phone, desktop, dark theme and English passed. Ordinary-session method choices, read-only calculation controls, changed totals/reconfirmation, close-during-save, missing/zero settings navigation and same-page focus were exercised with synthetic API data. Screenshots in `/private/tmp/jubbad-method-visual/`.
- **Review:** two mutation lifecycle/uncertainty issues fixed and reviewed; final detector returned zero findings; `git diff --check` passed.
- **Release:** uncommitted on `feat/payment-calculation-method`; no merge or deployment. No schema migration or LINE-card content change.
