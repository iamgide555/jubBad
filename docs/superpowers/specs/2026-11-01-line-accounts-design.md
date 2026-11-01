# LINE accounts and per-player link/unlink — design

Date: 2026-11-01. Status: draft for owner review. Not built.

## Why

A host cannot see or manage which LINE account belongs to which player from the
screen where they manage players (จัดการผู้เล่น, `web/src/app/pages/player-roster`).
Today:

- The only durable LINE-to-player mapping is `PlayerLineAccount`, filled by the slip
  flow (a player taps "this is me" on the pay page, or the host links from slip
  review). Its only UI is inside slip review (`ยกเลิกการผูก`), per session.
- When someone posts a roster in a linked LINE group, `LineRosterMessage` keeps the
  sender's id and name, but that table is a message log: 20 newest per group, 30 days,
  one row per message, no avatar. Nothing reads the sender fields.

The host wants: one place to see every LINE account JubBad knows in this group, with
name and avatar, and to link or unlink an account to a player right where players are
managed. A player who mapped themselves through payment must show up there too.

## Goals

1. A durable directory of LINE accounts seen in a group, filled from every source we
   already touch: roster post in the LINE group, slip upload, pay-page "this is me",
   host link.
2. Show name and avatar for each account.
3. In จัดการผู้เล่น: each player row shows their linked account (avatar + name) and
   offers link / unlink.
4. A "LINE accounts" list for the group (button in จัดการผู้เล่น): every account,
   whether linked or not, with who it is linked to, and link / unlink from there too.
5. Unlinking removes only the mapping. The account stays in the list as unlinked.
6. Shape the data so one LINE account can later be linked to players in several of the
   owner's groups, without a schema rewrite.

## Non-goals

- Any cross-group UI or cross-group linking now. Only the data shape is future-proofed.
- Auto-linking or name-based suggestions. A roster has names, not LINE ids; matching a
  LINE display name to a player name would be the same fuzzy-never-auto-links trap as
  `engines/fuzzy-match.ts` (see `docs/overview.md`). Link is always a host tap.
- Listing LINE group members who never interacted with the bot. We only know accounts
  that did something.
- Changing slip review's UI or the pay page's behavior. They keep working and feed the
  new directory.
- Merging duplicate players.

## Anti-goals (a failure even if it technically works)

- A host in group B ever learning that an account is also known in group A, even when
  the same owner runs both. Decided with the owner: never show across groups.
- Raw LINE user ids or avatars on any public (`@Public`) response.
- An unwanted link created without a host tap or the player's own "this is me".

## Decisions made with the owner

- New table above the group: one `LineAccount` row per LINE user id.
- Per-group membership is a join table, not a `groupId` array (SQLite has no array
  type, an array cannot be indexed or carry per-group facts, and a join row cascades
  with the group).
- Unlink keeps the account listed.
- Never show across groups.

## Data model

```
LineAccount            one row per LINE user id (global)
  id           cuid pk
  lineUserId   unique
  displayName  nullable
  pictureUrl   nullable
  profileAt    nullable   when name/avatar were last refreshed
  createdAt, updatedAt

LineAccountGroup       "this account is known in this group"
  id           cuid pk
  groupId      -> Group.code, onDelete Cascade
  lineAccountId-> LineAccount.id, onDelete Cascade
  source       'roster' | 'slip' | 'claim' | 'host'   first source that created the row
  firstSeenAt, lastSeenAt
  unique (groupId, lineAccountId)

PlayerLineAccount      the link, still per group (a Player belongs to exactly one group)
  groupId, playerId (as today)
  lineAccountId -> LineAccount.id      replaces the raw lineUserId and displayName columns
  linkedBy     'self' | 'host' (as today)
  unique (groupId, lineAccountId)   one player per account per group (as today)
  unique (groupId, playerId)        one account per player (as today)
```

Cross-group later: the same person in two groups is two `Player` rows (one per group),
each linked to the same `LineAccount`. No array and no schema change needed.

Visibility rule: every query that lists accounts goes through `LineAccountGroup` with
the caller's `groupId`. There is no endpoint that lists a `LineAccount` without a group
filter, and no response carries a count or flag from another group.

### Migration and backfill

One Prisma migration. It must preserve existing links. In SQL, in this order:

1. Create `LineAccount` and `LineAccountGroup`.
2. Backfill `LineAccount` from distinct `lineUserId` across `PlayerLineAccount`
   (display name from the link), `PendingSlip` (name and picture), and
   `LineRosterMessage.senderUserId` where present (name from `senderName`).
3. Backfill `LineAccountGroup` per (group, account) found in those same three tables,
   with `source` from the table it came from; `firstSeenAt`/`lastSeenAt` from the
   row's own timestamps.
4. Rebuild `PlayerLineAccount` with `lineAccountId` populated from step 2, then drop
   the old columns.

Other tables that store a raw `lineUserId` as an informational string (`SlipReference`,
`SessionPayment`, `PendingSlip`, `SlipDuplicate`, per the schema comments) are not
changed.

## Capturing accounts

A single service, `LineAccountsService`, owns writes. `touch(groupId, profile, source)`
upserts the `LineAccount` (setting name/avatar only when it has them, never blanking an
existing value) and the `LineAccountGroup` (`lastSeenAt = now`).

- **Roster post** (`LineRosterService.capture`, after the message is stored): touch with
  `source 'roster'`. Profile comes from LINE's group member profile call, which already
  runs (`LineClient.memberName`) but throws away the avatar. Extend it to return name
  and `pictureUrl`, with the same 24 h cache. A failed lookup still records the account
  (id only) and keeps any name already stored. Capture stays gated on the owner's paid
  plan exactly as today.
- **Slip upload** (where `PendingSlip` is created): touch with `source 'slip'`; the LIFF
  profile already carries name and `pictureUrl` (`liff-identity.ts`).
- **Pay-page claim** (`claimPlayer`): touch with `source 'claim'`, then create the link
  with `linkedBy 'self'`. Same "first claim wins, never overwrites" rule.
- **Host link** (new API, and the existing session-scoped `setLink`): the existing
  endpoint resolves its `lineUserId` through `LineAccount` and touches with `'host'`.

Profile refresh: a touch with a fresh profile updates name/avatar and `profileAt`; a
touch without one leaves them alone.

## API (host-only, group-scoped, under existing `AuthGuard` + `OwnershipGuard`)

Routes live beside the other `groups/:code/line/...` routes. The browser addresses an
account by `LineAccount.id`, never the raw LINE user id.

- `GET  /groups/:code/line/accounts` → every account in the group:
  `{ id, displayName, pictureUrl, source, firstSeenAt, lastSeenAt, player: { id, name, linkedBy } | null }`.
- `PUT  /groups/:code/line/accounts/:accountId/player` body `{ playerId }` → link.
  Replaces the player's current link if they have one. Refuses with 409
  `ACCOUNT_ALREADY_LINKED` if the account is linked to a *different* player (host must
  unlink that first, matching today's `setLink`), 404 if the account is not in this
  group or the player is not in this group.
- `DELETE /groups/:code/line/accounts/:accountId/player` → unlink; idempotent; the
  account row and its group membership stay.
- The player list the roster page already loads (`ManagedPlayer`) gains
  `lineAccount: { id, displayName, pictureUrl, linkedBy } | null`, so rows render
  without a second call.

Concurrency: the existing lock is per session, so group-level link writes rely on the
unique constraints and map a unique violation to 409, as `setLink` does today.

Plan: view, link and unlink are not plan-gated (this is data already held; locking a
host out of managing it on lapse helps no one). New accounts only enter via capture,
which already stops when the plan lapses.

## Web: จัดการผู้เล่น

- **Player row:** linked → small avatar + LINE name and a "ยกเลิกการผูก" action.
  Unlinked → a "ผูก LINE" action opening a picker of this group's *unlinked* accounts
  (avatar, name, last seen), with a name filter. One-handed, 44px targets (PRODUCT.md).
- **"บัญชี LINE" button** near the top of the page → the group's full account list:
  avatar, name, last seen, source badge, and either the linked player's name with an
  unlink action, or "ผูกกับผู้เล่น" opening a picker of players (those with no LINE link
  first). Filter: ทั้งหมด / ยังไม่ผูก.
- Empty state explains how accounts appear (a roster posted in the LINE group, a slip,
  or a player tapping "this is me"). It does not promise a member import.
- Linked-by label distinguishes `self` from `host`, as slip review does.
- Avatars render with `referrerpolicy="no-referrer"` and a fallback initial, as in
  `slip-review.html`; LINE picture URLs can expire or fail.
- Strings: Thai source in `i18n`, English in `messages.en.xlf`, no typeface that drops
  Thai. Presentation (dialog vs sub-route for the list) is left to the builder; a
  sub-route is preferable if the phone back button should close it.

## Retention (my call, marked for review)

- A linked account is never dropped by cleanup.
- An *unlinked* `LineAccountGroup` not seen for 365 days is deleted by the existing
  periodic sweep.
- A `LineAccount` with no remaining `LineAccountGroup` is deleted in the same sweep
  (this is also what cleans up after a group is deleted, since the cascade removes the
  join rows only), so we do not hold names and avatars for people in no group.

## Tests and docs

- Server (vitest): capture upserts and idempotence; a name-less touch never blanks a
  stored name; link / unlink / replace / 409; cross-group isolation (an account known in
  groups A and B is invisible as such from either; an owner mismatch is 404 per
  `OwnershipGuard`); migration backfill preserves every existing link; sweep rules.
- Web: row states (linked, unlinked), picker, unlink keeps the account listed, empty
  state, filters. Keep the existing `slip-review` and pay-page specs green.
- Docs: update `docs/overview.md` (why accounts are global but listed per group, why a
  join table and not an array, why never auto-link by name) and the data-model line in
  `CLAUDE.md`.

## Left to the builder

- Exact component layout and copy, within the constraints above.
- Whether `touch` runs inside the capture transaction or right after it.
- Naming of the Prisma migration and the exact SQL for the backfill.

## Calls I made (not yet confirmed by the owner)

1. The browser uses `LineAccount.id`, not the raw LINE user id.
2. View / link / unlink are not plan-gated; only capture is.
3. Retention: 365 days for unlinked, never for linked.
4. One player still has at most one LINE account per group (today's rule); two phones
   for one player are out of scope.
5. Presentation of the account list (dialog vs sub-route) is open.
6. Unlink has no confirm step, since it is recoverable and loses nothing.

## Provider check — resolved 2026-11-01

Verified on production data (read-only count): the one LINE id seen through the bot and
the one seen through the pay page are the same id. Both channels are under one provider,
so one person maps to one `LineAccount` and the backfill merges correctly. Background
kept below for the record.

LINE user ids are per provider. Two sources write ids into this directory:

- Messaging API channel (the bot): `LineRosterMessage.senderUserId`, `User.lineUserId`.
- LINE Login channel (the LIFF pay page): `PlayerLineAccount`, `PendingSlip`.

No existing code compares ids across these two channels (the slip flow is LIFF ids end to
end), so nothing in production has proven they match yet. If both channels sit under one
provider, one person gets one `LineAccount`. If not, the same person shows up as two
accounts in the list (one from a roster post, one from the pay page). Nothing breaks, but
the list shows duplicates. Confirm the two channels share a provider in the LINE
Developers Console before building, or check prod data for overlapping ids.
