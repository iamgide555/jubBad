# Slip Review Evidence Implementation Plan

**Goal:** Make host slip review amount-safe and preserve evidence until explicit collection close.

**Architecture:** Add private image storage and additive metadata migration, integrate service-side validation and close lifecycle, then extend host and public Angular screens.

**Tech Stack:** NestJS, Prisma/SQLite, filesystem, Angular, Vitest.

---

## Tasks

### Task 1: Image Storage and Additive Schema

- [x] **Red:** Add isolated filesystem/DB lifecycle tests in `server/src/sessions/slips/slip-images.service.spec.ts` for save/read/expiry/session purge/orphans and private paths.
- [x] **Green:** Add schema fields and migration, generate Prisma client, implement `slip-images.service.ts` and `slip-images.module.ts`. Verify tests using temporary storage and migrated test DB.

### Task 2: Amount-safe Review and Collection API

- [x] **Red:** Add service/HTTP tests for amount sums, correction, closed state, image ownership and race boundaries.
- [x] **Green:** Integrate images into submission, owner-only image API, review validation, per-player snapshots and close workflow. Register modules and cleanup paths. Extend public status with pending and closed data.

### Task 3: Host and Public UI

- [x] **Red:** Extend host review/service and payment status tests for image review, amount totals, disabled mismatches, close confirmation and status labels.
- [x] **Green:** Implement UI and English translations using existing visual tokens; include image-expired/missing fallback and old slips without images.

### Task 4: Release Verification

- [x] **Verify:** Run full tests/builds/lint; inspect mobile/desktop/enlarged render; complete independent spec/code review; update overview/deploy notes; archive completed plan/spec.
- [ ] **Release:** Commit scoped changes, backup production DB, apply migration and deploy branch, verify API health/read-only boundary. Preserve unrelated handoff/cache files.
