# Host LINE payment management and link directory

- **Status:** Approved and implemented on `feat/host-line-manager`; owner authorized commit and deployment on 2026-11-02. Real-phone check pending.
- **Decisions:** Host payment access applies to every owned group. A host DM link adds a directory membership only to the group that generated its code.

---

## Approach

| Approach | Benefit | Cost |
| --- | --- | --- |
| **Extend existing LINE payment access — recommended** | Reuses verified LINE identity, card gate, collector UI and payment rules | Existing internal collector names also cover hosts |
| Separate host LINE routes and screen | Host-specific names | Duplicates routes, UI and authorization tests |
| Require host to become collector | Few authorization changes | Conflicts with automatic owner access and displaces the actual collector |

- **Choice:** Extend the current access check with an owner match and return the payment source internally. Keep public route names and `{collector: boolean}` response compatible.

---

## Payment access

- **Host identity:** Compare the verified viewer's LINE user id with the bill group's current owner's `User.lineUserId`. Never accept an owner id, LINE id or payment source supplied by the browser.
- **Scope:** Access covers every group currently owned by that user, including groups with no collector, no directory membership for the host, no bot group link, or DM roster capture switched off.
- **Gate:** Still require the current confirmed payment-card token, eligible Host plan and verified LINE viewer. Existing collection-close rules remain enforced by payment methods.
- **Precedence:** If viewer matches both host and collector, host wins. A tick stores `source: 'host'`; collector-only ticks remain `source: 'collector'`. Existing paid marks retain their original source.
- **Revocation:** Read ownership and linked host identity on every request. Host unlinking removes the owner-based grant on the next request. An independently assigned collector grant may still apply under existing collector rules. Ownership transfer removes former owner's grant.
- **Capabilities:** Use existing LINE management screen for panel, private images, tick/untick, waiting-slip resolve/dismiss, duplicate dismissal and collection close. Host ticks show existing **โฮสต์ติ๊ก** chip.
- **Boundary:** This feature adds payment management only. LINE management continues to hide account linking, sender reassignment and saved receiver-name changes; those remain in authenticated JubBad host UI.

## Group linking and directory membership

- **Group command:** After successful group `/link <code>`, record the command sender in the redeemed JubBad group's directory with source `link`. Fetch name/avatar using existing `LineClient.memberProfile(lineGroupId, senderUserId)`.
- **Unlink race:** After the group member profile lookup, record under the existing group lock and recheck that the same LINE group is still linked. Unlinking or bot removal during the lookup must not recreate directory membership.
- **No sender:** A successful link without `senderUserId` still succeeds; skip directory recording.
- **No automatic powers:** Directory membership grants no payment access and creates no player link. Host may use JubBad to link the account to a player and explicitly select that player as collector.
- **Host DM command:** After successful host redemption, record that host account with source `host` in only the code-generating group, provided the user still owns it at redemption. Do not add memberships to other owned groups.
- **Changed or missing group:** Preserve existing account-link behavior, but skip directory insertion when the code's group is missing, null or no longer owned by the linking host. Return an eligible group code from the successful redemption transaction; never infer group from display name.
- **Host profile:** Add `LineClient.userProfile(userId)` using `GET /v2/bot/profile/{userId}`. Use the existing client transport and return name/avatar or null. [LINE's profile reference](https://developers.line.biz/en/reference/messaging-api/nojs/#get-profile) documents this endpoint and profile availability.
- **Failure isolation:** Lookup failure still attempts `touch` with null name/avatar. Directory write failure logs a fixed warning and leaves redemption and success reply intact. Do not log codes, access tokens, raw LINE ids or profile data.
- **Existing accounts:** Reuse `LineAccountsService.touch`: preserve first source/first-seen timestamp and nonempty stored profile, advance last-seen, and reuse the global account. No automatic player link, backfill or new cleanup policy.

## Presentation and storage

- **Directory source:** Add `link` to server/browser source unions and server source decoding. New label: **เชื่อมกลุ่ม** / **Group link**, i18n id `lineAccounts.sourceLink`. Existing `host` label remains unchanged.
- **Payment screen:** Reuse existing management view and existing host/collector chips. No new host screen, button or role response field is needed.
- **Database:** No schema migration expected: owner identity, directory memberships and payment source fields already exist; directory source is a string.
- **Legacy users:** Already-linked hosts receive owner-based payment access immediately after rollout. Existing directory rows remain unchanged; no retrospective link-account population.

---

## Acceptance and validation

- **Authorization:** Verify host with/without collector, multiple owned groups, DM-only groups, disabled DM capture, unrelated owner, ownership transfer, unlink and changed LINE identity. Test host/collector overlap and independent collector fallback after host unlink.
- **Gates:** Exercise every management route with owner identity; preserve invalid/old token, lapsed plan, unverified identity, closed-collection and uniform refusal behavior. Preserve private response field filtering and status response key set.
- **Attribution:** Owner tick is `host`; collector-only tick is `collector`; neither replaces an existing slip mark.
- **Directory:** Verify correct group, sender identity, name/avatar, null-profile fallback, preserved first source/profile, no player auto-link and no access from directory membership alone.
- **Failure cases:** Invalid/expired/used link codes perform no lookup or directory write. Profile/write failures do not undo successful linking or change its reply. Missing sender and changed group ownership remain safe.
- **UI:** Verify new source label and existing management host chip. Run focused server/web suites, then root `npm test`, server lint and production builds.
- **Delivery:** Implement on a feature branch after review. Commit, push, merge and deploy only when owner asks. Leave unrelated working-tree files untouched.
