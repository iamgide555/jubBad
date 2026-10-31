# Slip Review Evidence and Collection Close

## Approved Behavior

- **Evidence:** Keep new accepted slip images privately until collection closes or retention expires. Owning host alone can view them; never expose images, references or OCR text through public status.
- **Review:** Show OCR amount, editable reviewed amount, selected players' sum and difference. Require a positive integer amount in satang equal to selected unpaid players' current total, on server and page. Save reviewed amount and correction time. One slip can pay multiple players only when their total matches.
- **Close:** Enable `ปิดการเก็บเงิน` only for a confirmed, current, complete bill with at least one payable player, all payable players marked paid and no pending reviews. Confirmation names irreversible image deletion and image count. Closing deletes images, records close time, blocks uploads/claims/payment mutations, and preserves payment records and duplicate references. Read-only status remains available. No reopen action in this scope.
- **Status:** Red unpaid, amber pending, green paid, with text labels. Pending applies only to an unpaid linked sender whose unresolved slip amount equals their bill; ambiguous submissions appear only in aggregate pending-slip count. Closed collections show `เก็บเงินครบแล้ว`.
- **Retention:** 30 days after upload, confirmed by owner. Expired images become unavailable while records remain. Closing deletes images sooner.

---

## Technical Contracts

- **Schema:** Add nullable `Session.paymentCollectionClosedAt`, nullable `PendingSlip.reviewedAmountSatang` and `reviewedAt`, and `SlipImage` metadata with session relation, random UUID id, reference, content type, creation/expiry timestamps and unique session/reference.
- **Storage:** Private HDD directory `/mnt/hdd2/jubbad/slips`, explicitly bound to `/app/slip-images` via `SLIP_IMAGE_HOST_DIR`, excluded from SQLite backups and Docker build context. Local API defaults to `prisma/slip-images`. `SlipImagesService.save(code, reference, image, now)`, `read(code,id,now)`, `list(code,now)`, `removeForReference(code,reference)`, `purgeSession(code)`, `purgeGroup(groupCode)`, `purge(now)`; files use UUID names, owner-only permissions. Expired/orphaned files swept periodically.
- **Owner API:** Existing `GET payments` adds `collection: { closedAt, canClose, imageCount }`, waiting rows add `imageId: string|null`, `linkedPlayerId: string|null`. `GET payments/images/:id` returns authenticated image with no-store/nosniff headers. `POST payments/close` requires `{confirmDeleteImages:true}` and is retry-safe. Existing resolve body adds optional `reviewedAmountSatang` (fallback to stored amount).
- **Public API:** Status adds optional `closedAt`, `pendingSlipCount`, rows `pending`; pay view adds `collectionClosed`. Shared card config remains readable after close; submission and claim refuse closed bills.
- **Integrity:** Per-session lock guards close versus upload, tick/untick, review and account-link writes. Shared group lock coordinates upload/unlink image writes; lock order is group then session. Closed collection rejects bill/shuttle/walk-in billing edits and card reconfirmation to preserve finality. Cleanup failures are visible and retryable. Additive migration preserves old rows; rollback uses prior build and leaves new fields unused.

---

## Acceptance

- **Tests:** Reject over/under amount, invalid amount, unknown amount without review, paid-player selection, closed uploads and unauthorized image reads. Verify multi-person exact sum, per-person paid snapshots, correction audit, image lifecycle, expiry, close preconditions, close retry, preserved paid/references and public status after close.
- **UI:** Host thumbnail/enlarged evidence, amount correction/sum/difference, destructive close confirmation, closed controls, three status colors, Thai/English, 360px and enlarged text.
