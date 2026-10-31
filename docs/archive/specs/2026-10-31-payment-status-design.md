# Read-only Payment Status

## Approved Scope

- **Entry:** Add `ดูสถานะการจ่าย` to newly generated payment cards beside the existing actions.
- **Viewer:** Any verified LINE viewer holding the current confirmed bill token can read the list without claiming a player or logging into JubBad.
- **Content:** Show bill date, paid/unpaid counts, player names, amounts and paid/unpaid status. Show unpaid players first, preserving bill name order within each section.
- **Refresh:** Explicit refresh reads current data. Failed refresh hides old results so stale payment state cannot be mistaken for current state.
- **Read-only:** No mutations, review reasons, references, LINE profiles, account numbers or host controls appear in this response or page. Existing owner routes retain authentication and ownership checks.

---

## Implementation

- **API:** `GET /sessions/:code/slip-pay/status` reuses verified LINE identity, confirmation-token and plan gates. Old tokens fail after reconfirmation. Set `Cache-Control: no-store`.
- **Link:** LIFF suffix `/payment-status/<code>/<token>` routes to a new Angular component, including initial `liff.state` handoff and login query preservation.
- **UI:** Extend current `DESIGN.md` styling, Thai source plus English translations, readable at 360px with 44px refresh target. Display paid/unpaid as text, never color alone.
- **State:** Recorded `SessionPayment` marks define paid status; pending slips remain unpaid until accepted. Bill edits do not erase existing marks. Show changed-amount marker when applicable.
- **Compatibility:** Cards without LIFF configuration keep their previous footer. No schema change. Existing chat messages do not gain buttons retroactively.

---

## Acceptance

- **Automated:** Verify allowed read without claim, rejected identity/token/plan, token revocation, fresh data after host edits, and refused anonymous status mutations. Verify card URL/action, LIFF suffix parsing, loading/login/error/empty/refresh UI and English build.
- **Manual:** Inspect mobile and desktop rendering. Real Android login/upload already confirmed by owner; new status entry still needs phone verification. iPhone remains unavailable for testing.
