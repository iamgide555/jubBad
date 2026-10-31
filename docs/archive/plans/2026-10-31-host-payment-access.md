# Host Payment Access Implementation Plan

**Goal:** Allow fully funded slip reviews and provide direct host status access after bill delivery.

**Architecture:** Reuse recorded card send time and existing host APIs; add dedicated review sheet and read refresh, with a minimal LINE share-success acknowledgement.

**Tech Stack:** NestJS, Angular signals, Prisma, Vitest.

---

## Tasks

### Task 1: Backend Funding and Sent State

- [x] **Red:** Add service/HTTP tests proving overpayment allowed, shortfall blocked, successful token/LINE acknowledgement records sent time while invalid/old tokens refuse.
- [x] **Green:** Update amount comparison and add share acknowledgement endpoint using existing identity/throttle and confirmed-card gates. Verify auth boundary.

### Task 2: Direct Host Panel and Refresh

- [x] **Red:** Add summary/bill entry-gating tests, dedicated-sheet tests and refresh/overpayment UI tests.
- [x] **Green:** Implement status sheet, direct buttons after sent, shared refresh and meaningful difference copy; update Thai/English strings.

### Task 3: LINE Share Tracking

- [x] **Red:** Add success/cancel/error/retry tests to LINE share page/service.
- [x] **Green:** Record send only after successful picker; failed status-save offers retry without posting card again.

### Task 4: Verification and Release

- [x] **Verify:** Run relevant/full tests and production builds; inspect mobile/desktop/English/enlarged screens; independent spec/code review; update overview and archive completed docs.
- [x] **Release:** Commit, push and deploy API/web without migration; verify live permissions and health.


---

## Release Evidence

- **Runtime:** `0630bf0`, deployed on `feat/slip-payments`; no pending migration, API restart count zero.
- **Tests:** Server full suite 1,756 passed plus the added reconfirmation case passed in its three-test focused suite; web full suite 1,835 passed. Production builds, server lint/type checks and independent spec/code/visual reviews passed.
- **Browser:** Phone, desktop, dark, English and enlarged text checked. DM-only invoice hid status; successful send exposed direct entry. Exact/overpayment enabled confirm, shortfall blocked, refresh updated marks/time and preserved drafts.
- **Backup:** `jubbad-2026-10-31T04-23-08-715Z.db` before deploy, integrity check passed.
- **Live:** Site `200`, host status without login `401`, share acknowledgement without identity `404`; image HDD mount unchanged.
