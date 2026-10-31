# Host Payment Access and Overpayment

## Approved Behavior

- **Confirm:** After selecting who the slip covers, allow confirmation when the reviewed amount covers their combined bill total. Disable on shortfall, missing/invalid amount, no selected player, closed collection or in-flight action. Label the difference as `ยังขาด ฿X`, `จ่ายเกิน ฿X` or `ยอดตรงกัน`.
- **Accounting:** Keep actual reviewed slip amount on the review record and each paid player's own bill share on payment marks. Overpayment is not automatically transferred into other bills or player credit.
- **Direct entry:** Show `สถานะการชำระเงิน` on the host summary and bill pages only after the bill card was sent to LINE (bot push or successful LINE share picker). Merely confirming, opening the share page, cancelling the picker or receiving a host DM does not unlock it. This is session-level access after its first recorded send: later bill edits/reconfirmation preserve access so the host can continue checking existing payments.
- **Host panel:** Open directly to counts, players and pending reviews in a separate sheet; no invoice preview to scroll past. Keep owner authorization for all host details/actions.
- **Refresh:** Provide explicit refresh of payment marks, pending slips, duplicates and account links together. Show in-progress state and last successful refresh time; failed refresh must be visible without losing review drafts.

---

## Implementation

- **Backend:** Change resolution sum check from equality to `selectedTotal <= reviewedAmount`. Owner panel's existing `lastSentAt` records bot delivery or LINE picker success. Add token-and-LINE-identity gated share acknowledgement, never on page load; preserve current token/hash and record no payment marks.
- **Frontend:** Reuse `SlipReview` in a dedicated host status sheet supplied current bill rows by the owner payment panel API. Summary/bill entry checks confirmed panel `lastSentAt`; no new player-facing permissions. Add refresh to shared review component. Persist picker acknowledgement after successful share, with a status-save retry that never resends card.
- **Compatibility:** No schema migration; existing bot-sent bills unlock immediately. Old manual share sends have no recorded success and cannot be reliably inferred; future successful shares record it.

---

## Verification

- **Tests:** Exact/overpayment allowed, underpayment rejected without writes. Entry hidden until send; DM/cancel/load do not unlock. Successful share records sent state; revoked token and invalid LINE identity refused. Direct panel opens to review without invoice preview. Refresh updates data/time and prevents duplicate requests.
- **Visual:** Phone/desktop/English/200% text checks using existing Daylight Court tokens and 44px controls.
