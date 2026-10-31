# Read-only Payment Status Implementation Plan

**Goal:** Let payment collectors read current paid/unpaid state directly from the LINE bill card.

**Architecture:** Extend the existing token-gated slip API with a minimal read projection. Add a separate Angular page and LIFF entry, reusing current identity bootstrap and card-generation paths.

**Tech Stack:** NestJS, Prisma, Angular signals, Vitest.

---

## Tasks

### Task 1: Read-only API

- [x] **Red:** Extend `server/src/sessions/slips/slip-pay.controller.spec.ts` with status reads, identity/token refusal, revocation, lapse, fresh paid state, limited fields and mutation refusal. Run `SESSION_SECRET=payment-status-tests npx vitest run src/sessions/slips/slip-pay.controller.spec.ts` from `server/`; new allowed-read assertions must fail.
- [x] **Green:** Add `PaymentStatusView` and `paymentStatusView` to `server/src/sessions/slips/slip-payments.service.ts`; add GET controller using existing `viewer` and `payToken`; allow route in `server/src/auth/auth.boundary.spec.ts` walks. Run focused specs.

### Task 2: Card and LIFF Routing

- [x] **Red:** Add encoded status URL/card-footer tests in `server/src/line/payment-card.spec.ts` and login-suffix handoff tests in `web/src/app/pages/line-share/line-share.spec.ts`. Run focused suites; new action/handoff expectations must fail.
- [x] **Green:** Add optional status URL to `paymentCardMessages`, provide it in both `server/src/sessions/payment-card.service.ts` send/share paths; add Angular route and LIFF handoff for `payment-status`. Verify send/share integration expectations.

### Task 3: Page and Verification

- [x] **Red:** Add `status` request tests to `web/src/app/core/slip-pay.service.spec.ts` and new `web/src/app/pages/payment-status/payment-status.spec.ts` covering identity bootstrap, read-only rows, counts, empty/error/revoked states, refresh and no name claim.
- [x] **Green:** Implement separate page with existing tokens and refresh button; add Thai/English strings in `web/src/locale/messages.en.xlf`. Run focused tests.
- [x] **Verify:** Run server/web suites and production builds; render mobile/desktop UI; inspect API authorization and card integration diff; update `docs/overview.md`. Archive completed spec/plan. Commit only task files, preserving unrelated handoff/cache changes.
