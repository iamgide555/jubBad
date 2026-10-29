# Payment Review Clarity Implementation Plan

> **Execution:** inline with test-first changes; approved scope from payment critique and user acceptance.

**Goal:** verify total and receiver before scanning roster, understand requests in progress, and repair account errors directly.

**Architecture:** retain existing `PaymentPanel`, full LINE preview, focus guards and delivery behavior. Add concise review summary, progress signals, field validation and clearer entry/disclosure controls. No server/model changes.

**Tech stack:** Angular signals/templates, existing CSS tokens, Vitest, Thai/English XLIFF catalogs.

---

## Tasks

- [x] **Regression checks:** extend `web/src/app/shared/payment-panel/payment-panel.spec.ts` for summary-before-rows, pending initial read/confirm/send feedback, invalid account focus and accessible descriptions; run focused suite and observe failures.
- [x] **Panel behavior:** modify `payment-panel.ts` to track loading and validate bank/name lengths plus number format; preserve drafts, server refusal handling and request focus.
- [x] **Presentation:** modify `payment-panel.html` and `.css` for session/total/payee above full preview, progress/error text and rotating disclosure chevron. Keep sticky header/action bar.
- [x] **Entry/locales:** change `session-summary.html` banner to `เปิดใบเก็บเงิน` with new ID; append new source/English units to both XLF catalogs.
- [x] **Verification:** focused/full web tests, production/localized development builds, phone/desktop browser checks including dark/English and slow/invalid states, detector and diff review.

---

## Acceptance

- **Summary:** date, total and valid receiver precede roster; no provisional amounts for incomplete bills.
- **Progress:** initial fetch, confirmation and delivery explicitly announced; repeated taps guarded and focus preserved.
- **Validation:** relevant fields describe errors; first invalid input focused; input retained. Bank max 40, name max 80, number 6–20 digits/spaces/dashes with at least 6 digits.
- **Release boundary:** branch changes only; no merge or deployment during this pass.

---

## Verification results

- **Regression proof:** six new checks failed before implementation; panel/summary focused suite passed 225 checks afterward.
- **Final web suite:** 70 files passed; 1,651 tests passed, 1 existing todo.
- **Builds:** localized development and production builds passed; existing dashboard CSS and LIFF CommonJS warnings remain.
- **Browser checks:** phone, desktop, dark theme, English and missing-input variants passed; summary above roster visible, no horizontal overflow, invalid-number focus and delayed request feedback verified. Synthetic data only; no real LINE sends. Screenshots: `/private/tmp/jubbad-clarity-visual/`.
- **Review:** disclosure chevron orientation corrected; no further concrete behavior issues found. Final detector returned zero findings; `git diff --check` passed.
- **Release state:** local branch `fix/payment-review-clarity`, uncommitted; no merge or deployment.
