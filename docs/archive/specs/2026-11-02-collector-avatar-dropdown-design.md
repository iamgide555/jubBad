# Collector avatar dropdown

- **Status:** Implemented and validated on `feat/collector-avatar-dropdown`. Owner authorized commit and deployment on 2026-11-02; release outcome is recorded in `HANDOFF-codex.md`.
- **Problem:** Expanded collector choices dominate a single-value account setting, especially on phones.
- **Direction:** Preserve existing design tokens, LINE avatar component and payment-access rules. One closed field replaces the always-visible list.

---

## Interaction

- **Placement:** In group settings, place **เจ้าของบัญชี** directly after account name and before Save, in the same account form. Remove its separate divider and section spacing; keep account removal below the form actions. Collector changes retain their existing independent confirmation/save.
- **Closed field:** Show selected LINE avatar, player name and chevron. Show existing **ไม่มี** choice when nobody is selected or saved link is stale.
- **Open choices:** Show only players with linked LINE accounts, each with avatar, player name and LINE name. Keep **ไม่มี** to clear the collector and check the current selection.
- **Confirmation:** Close dropdown before asking the existing permission question; include the chosen avatar. Selection changes only after confirmation. Cancel or Escape preserves the previous choice.
- **Keyboard:** Trigger opens with Enter/Space or arrows. Choices are native buttons supporting Tab, Enter/Space, arrows, Home/End and Escape. Escape returns focus to the field; focus leaving the component or outside click closes choices without changing access.
- **Busy state:** Close choices, refuse further selection and keep trigger focusable with `aria-disabled`. Restore focus to that trigger after confirmation/cancel rather than a hidden option.
- **Phone layout:** Bound list height and scroll choices internally. Open above the field when there is insufficient space below. Long Thai/English names wrap without horizontal overflow.
- **Existing states:** Preserve load failure/retry, no linked players, optional hidden picker and stale saved-link warning/clearing.

## Scope

- **Implementation:** `web/src/app/shared/collector-picker/collector-picker.ts`, `.html` and `.css`.
- **Verification:** Component spec plus the two parent integration specs for `pay-account-panel` and `payment-panel`.
- **Unchanged:** Server authorization, API payloads, player mapping and confirmation wording. Reuse existing translated labels; no new locale units needed.

---

## Validation checklist

- [x] **Regression proof:** New collapsed-field, avatar, focus, outside-close and keyboard tests failed before implementation; phone opening-direction regression also failed before fix.
- [x] **Automated checks:** Full web suite: **1,987 passed**, one existing todo. Production build passes with existing dashboard CSS-budget and LIFF CommonJS warnings. Logs: `/tmp/jubbad-collector-release-tests.log`, `/tmp/jubbad-collector-release-build.log`.
- [x] **Visual and interaction checks:** Actual Angular page at desktop **1280×900** and phone **390×844**, light/dark themes. Long names wrap, menu stays within viewport, keyboard End/Enter works, Escape/reopen works, cancel restores original selection/focus, and confirmation saves through mocked API. Browser evidence: `/tmp/jubbad-collector-dropdown-browser-results.json`.
- [x] **Focus timing regression:** Browser check exposed option focus before Angular removed the menu's `hidden` state. Use `afterNextRender` with injected `Injector`; final browser matrix passes.
- [x] **Review:** Independent correctness/accessibility review approved; `git diff --check` clean. Impeccable detector reports no findings.
- [x] **Release authorization:** Owner explicitly requested commit and deployment on 2026-11-02. Preserve unrelated cache and untracked files.
