# Slip payment matching — design

Date: 2026-10-30. Status: draft for owner approval. Nothing is built.

## Intent and why

After a night, the host sends the bill to the LINE group (the payment card). Players pay in their own bank app and post the e-slip image in the same LINE group. Today the host scrolls the images and matches each sender to the roster by eye to find who has not paid. This feature makes the bot do that matching: it watches the group for slips, works out who paid, and shows paid/unpaid per person on the bill.

Two parts, which only work together:
1. **LINE account to player mapping** — so the app knows which player a slip sender is.
2. **Slip detection and amount matching** — so the app knows an image is a slip and that it covers what the player owes.

## Decisions already made by the owner

- **No paid slip-verification service** (Slip2Go, EasySlip, SlipOK, about 100 THB/month per group). Rejected on cost, 2026-10-30. Do not propose it again.
- **Auto-mark paid** when a mapped player's slip matches the amount they owe. Not "slip posted, host confirms" as the default.
- **One LINE account is one player.** But one account sometimes pays for friends, so a single slip may cover several players.
- **Roster-order inference is out.** A friend often posts the regulars' names in one message, so the sender of a roster message is not the player. Do not link accounts from who registered a name.
- **The bot is a free, unverified LINE account.** The group member-list API is not available. The bot only learns an account when that person sends a message or joins while the bot is in the group.
- **Do not store slip images.** The disk would fill quickly. Download, read, discard.
- **The host prompt shows the LINE display name and avatar** of an unknown sender, so the host can tell who it is.

## Phases (owner decision 2026-10-30)

Players currently post slips in the LINE group, which notifies everyone, including people who did not play that night. So the quiet path is built first.

- **Phase 1: pay-page upload.** Per-person paid state on the bill, with the host able to tick anyone paid by hand and undo (cash, or any case the app can't read). The player opens the payment card's pay page, uploads the slip there, and the app reads it with the shared slip pipeline. The sender is the logged-in LINE viewer, so mapping is self-service. Waiting slips (amount off, pays for friends) go to the host prompt.
- **Phase 2: group watching.** The bot reads slips posted in the group, with the group setup screen, the "who is this?" prompt for unmapped senders, and duplicate events. Open decisions 1 (privacy promise) matters mostly here.

Everything in "How it works" applies to both unless marked. The slip pipeline (QR, reference, OCR, amount match, duplicates) is shared; only the entry point differs.

## Goals

- Host opens the bill and sees who has paid and who has not, without reading the group chat.
- After the first night, a regular player's slip is recognised and marked paid with no host action.
- Zero ongoing cost, no new paid service.

## Non-goals

- Proving the money arrived. There is no bank-side check. The free QR read says "this looks like a slip", not "this is genuine".
- Reading the sender's name from slips. It is printed partly masked ("นาย ธนัช อ.") and cannot identify a LINE account. Only the receiver's name is read, for the wrong-recipient check.
- Partial payments, instalments, refunds.
- Storing or displaying slip images.
- Banks beyond what is tested, handled separately (see Risks).

## Anti-goals (a failure even if it technically works)

- A wrong auto-link or auto-paid that the host does not notice. A player marked paid who has not paid is worse than a player the host has to tick by hand.
- A host who must tap on every slip every night. That is today's problem moved into the app.
- Any fuzzy name match that links an account without a host tap (same rule as the roster fuzzy matcher).

## How it works

### Facts established by testing (throwaway spike, 2026-10-30)

Four real slips (SCB, Bangkok Bank, KBank, Krungsri), including two LINE-saved copies:
- A free QR library (jsQR) decoded the QR on all four. Payload: fixed prefix, a 3-digit sending-bank code (014 SCB, 002 BBL, 004 KBank, 025 Krungsri), the transaction reference (matches the reference printed on the slip), country, CRC. Length 64, KBank 59. No amount, no names.
- Free local OCR (tesseract.js, English model) found the exact amount string `172.00` on all four. Matching a known expected amount against the OCR text is more reliable than extracting an unknown amount.
- These four slips all had the same amount. Reliability across varied amounts, and speed per image on the home server, are unmeasured.
- The QR payload ends in a 4-hex-digit CRC-16 (CCITT-FALSE, over everything before it, including the final `9104`). It validated on all four slips (re-checked 2026-10-30). A normal photo, a PromptPay "pay me" QR (starts `000201`) or any other QR will not pass, so "slip-style QR" means: starts with the fixed slip prefix, has a valid CRC.
- The home server has about 15 GB RAM and 12 cores, so OCR load is not a capacity worry; it is still a latency worry for the webhook (see pipeline).
- Spike code is in the scratchpad only and is not to be kept; the builder re-creates it. The four test slips carry real people's names and must not be committed as test fixtures; use synthetic or redacted fixtures.

### Slip handling pipeline (per image message in a linked group)

0. **Never in the webhook's request path.** The webhook handler currently awaits each event in order and replies 200 afterwards (`line-webhook.controller.ts`). Reading a slip takes seconds, so the image event is queued and processed after the 200 goes back; otherwise roster capture and `/link` stall behind OCR and LINE may redeliver. Process one slip at a time per server (a small queue), with a cap on image size and on queue length per group, so a member spamming photos cannot starve the server. Idempotent on LINE's message id, so a redelivered event does nothing twice (same pattern as `LineRosterMessage.lineMessageId` being unique).
1. Download the image from LINE's content endpoint into memory. Never write it to disk. LINE usually re-encodes to JPEG; decode PNG too.
2. Decode the QR and validate it (prefix and CRC, see Facts). Anything that is not a slip-style QR is ignored completely and records nothing, so a normal photo leaves no trace.
3. Read the transaction reference from the QR. If it is already known (same group), the slip never pays anyone, but it is not dropped silently: record a duplicate event (sender, post time, reference) so the host can see it (see "Duplicate slips" below). No message is sent to the sender or the group.
4. Work out whether there is a bill this slip can count against (see Auto-paid rule). If there is none (no confirmed unpaid bill in the group), ignore the slip and **do not record its reference**, so it can still be matched if a bill is confirmed later. Only slips that are matched, queued for the host, or seen as duplicates have their reference recorded.
5. OCR the image and look for the amounts to match (below).
6. Discard the image. Keep only: transaction reference, bank code, sender LINE user id, posted time, matched amount, outcome, which players it paid. One exception: on a slip held for the host because the receiver name did not match, also keep the receiver name as read and the last digits of the receiver account, so the host can fix the saved name (see "Fixing the saved name").
7. Run the write (paid marks, pending-slip record) inside the existing per-session lock (`server/src/sessions/session-lock.ts`), so a slip landing at the same moment as a host edit or undo cannot interleave.

### Auto-paid rule

A player is marked paid automatically only when all hold:
1. The session's payment card is confirmed and not stale (`confirmedAt` set, content hash unchanged; the `stale` flag in `payment-card.service.ts`), and the image was posted after `confirmedAt`. A stale card means amounts are moving, so nothing is auto-marked until the host reconfirms; slips in that window go to the host list.
2. The sender's LINE account is mapped to a player, and that player is on this session's bill and still unpaid.
3. A valid slip-style QR is present.
4. The OCR text contains the amount that player owes as a whole token with two decimals (`172.00`, or `1,172.00` with separators). It must not match inside a longer number (`1172.00` is not `172.00`). A player who owes 0 is never auto-matched.
5. The transaction reference is new.
6. The receiver name on the slip matches the group's saved pay-account name (see open decision 2), when the group has one saved.
7. The date printed on the slip (read by OCR) falls between the day before the bill's night ended and the day after today, in Bangkok calendar days. Added at the final review: rule 1 meant "a slip for this bill", but a genuine old slip of the same amount (last week's, made before references were recorded) passed every other rule. A date that cannot be read holds the slip for the host (reason `date`), checked after the amount and before the receiver.

If the sender is mapped to a player who is not on tonight's bill, or the amount does not match, the slip is not auto-marked; it goes to the host (below).

### Paying for others (v1)

One slip may cover several players, and that is always the host's tick in the prompt. The app does not learn "this account usually pays for these friends" in v1; the earlier idea of remembering "also covers" sets and matching sums is a non-goal for now. A slip whose amount does not match the sender's own share goes to the host prompt, where the host can tick several players.

### Host prompt (the "who is this?" screen on the bill)

Shown for any slip that could not be auto-marked:
- LINE display name and avatar of the sender (looked up via the LINE group member profile call; the existing `memberName` helper in `server/src/line/line-client.ts` does the name).
- Amount read from the slip and time posted.
- Players who still owe that exact amount, pre-selected when only one matches.
- The prompt has two separate choices, decided by the owner 2026-10-30:
  1. **"This slip covers"** — the host ticks one or more players the payment is for (for example, someone paying more than their own share to cover friends). Confirming marks all ticked players paid.
  2. **"The sender is"** — the host optionally picks which existing player this LINE account is, if the sender is in the system. Picking one links the account to that player for future nights. The sender need not be among the ticked players, and need not be anyone: a person who only pays for friends and has no player of their own leaves it empty, and the account stays unlinked.
  When exactly one player is ticked and the account is unmapped, "the sender is" is pre-filled with that player; the host can change or clear it.
- LINE display name similar to a player's name is shown as a suggestion only, never auto-linked.
- A sender LINE will not identify (no user id because they have not consented to profile access) is shown as an unknown sender. The host can still tick players and mark them paid, but no account link is made.

### Duplicate slips (owner decision 2026-10-30)

Host-only. When a slip's reference was already used, the bill screen lists "duplicate slip" with the sender's LINE name and avatar, the time, and who the original slip was matched to (when known). It counts toward the waiting-for-attention badge until the host dismisses it. The bot does not DM the sender (push quota, and most players are not friends with the bot) and does not post in the group (a duplicate is usually innocent, and a public call-out would embarrass them). If a duplicate looks suspicious, the host talks to the person in LINE. A duplicate never marks anyone paid.

### Pay-page upload (phase 1)

The payment card already opens a LIFF page (`liffPayUrl` in `server/src/line/payment-card.ts`, route `/pay/:session/:token`). It gains a "send slip" step, about two taps once the account is known: the card button, then picking the photo, which starts the upload.
- **Identity.** The page gets the viewer's LINE identity from LIFF. The server must verify it (LIFF access token or ID token checked with LINE); it never trusts a user id sent by the page.
- **First time.** The player taps "I'm [name]" among the unpaid players. That links their account to that player (same one-account-one-player rule). The host sees which links were self-claimed and can change or remove them, because someone could tap another person's name. A name already linked to a different account is not offered again without the host.
- **After that.** The page opens on that player's own slip step with their name and amount shown.
- **Processing.** The upload goes through the same pipeline: read in memory, QR, reference, OCR, amount match, duplicates; never stored. An exact match marks the player paid ("paid by slip"). Anything else becomes a waiting slip for the host prompt.
- **Abuse limits.** The upload address is reachable by anyone holding the card link, so it needs an image-size cap, a rate limit per link and per account, and the same queue as the group path.
- **Unconfirmed.** Whether LIFF's photo picker works smoothly in LINE's in-app browser on iOS and Android has not been tested. Test before building the rest.

### Fixing the saved name from a waiting slip (owner idea, 2026-10-30)

A host who saved the wrong name at first would otherwise see every slip fall to the host prompt. When a slip is held only because the receiver name did not match:
- The prompt shows "receiver on the slip: X (account ending 5953), saved name: Y" with an **Update saved name to X** button.
- The host checks it is their own account and taps. The group's pay-account name changes, so later slips match. The host still ticks this slip's players as usual (one more tap), because the image is gone and the app does not re-read it.
- The button asks for a confirmation that states the new name. A mistaken tap would make slips to that person auto-pass from then on, so it must not be a one-tap change. The old name is shown in the confirmation and the change is undoable from the pay-account settings.
- Only offered for the receiver block read from the slip, and only when the amount and QR were otherwise fine, so a random mismatch does not nag the host.
- The check uses the group's current saved name (not the name frozen in an already confirmed card), so the fix also helps other waiting slips tonight. Whether to also correct an already-sent card is the builder's call.

### Host manual tick (phase 1, required)

Confirmed 2026-10-30: the host can tick any person paid by hand and undo it. Not available today. The only "จ่ายแล้ว N คน" in the app (`payment-panel.html`) counts early checkouts (a player's amount frozen when they leave early), not money received, and `Session.billConfig` stores no per-person paid state. The new paid status needs a clear name so it is not confused with that early-checkout count; the builder decides the wording.

### Group setup screen

A one-time screen per group listing the LINE accounts the bot has recorded (name and avatar; which accounts get recorded depends on open decision 1: everyone who speaks or joins, or only slip and roster posters), where the host maps each to a player. Avatars are fetched on demand through the existing cached profile lookup rather than stored, since LINE picture addresses change. This is the main way mapping is done; the slip prompt is the fallback. Only accounts the bot has seen appear. Quiet members show up once they post.

### Name suggestion from roster posts (phase 2, owner-confirmed 2026-10-30)

The bot already keeps the sender's LINE id and name with each roster message it captures (`LineRosterMessage.senderUserId`, `senderName`, `text`), so this needs no extra storage of chat.
- Each roster message is compared with the previous roster message in the same group. If the sender added **exactly one** name, the setup screen shows that name beside the sender's account as a suggestion. The host taps to accept it, or changes it to a different player. Never linked automatically.
- If that name matches no JubBad player, it is still shown as text, so the host can pick the right player or add one.
- If the sender added **more than one** name (for example a friend posting the regulars), there is no suggestion. The account is still saved in the list for the host to map later.
- The first roster in a group has nothing to compare with, so it gives no suggestion unless it holds exactly one name.
- Edited roster messages (`messageEdited`) are compared against the previous roster message, not the pre-edit text of the same message; the builder decides how to handle an edit that changes the added name.

### Bill screen

- Per person: unpaid, paid by slip (auto), paid by host (manual tick). Paid-by-slip is visibly different so the host can spot an auto-mark.
- The host can undo any paid mark and can tick a person paid by hand with no slip (cash payers).
- This is new state. Today the bill has no per-person paid status; `Session.billConfig` stores inputs only, never the bill. The builder decides where paid state lives.

## Data to add (builder's to design)

- A mapping from LINE user id to player, scoped to a group (one account, one player).
- A record of LINE accounts seen in a group (user id, display name, avatar, last seen), needed for the setup screen.
- Per-session paid state with who or what marked it.
- Seen transaction references per group, for duplicate detection (the 3rd call below widened this from per session), plus a small duplicate-event record (sender, time, reference, dismissed or not) for the host list.
- Currently the bot drops everything except text messages (`server/src/line/line-webhook.service.ts`, the message case). It must start handling image messages and recording sender ids without storing any text or image outside the pipeline above.

## Constraints

- Runs on the existing single-container NestJS server. No new paid service. OCR and QR run locally.
- Slip images are never persisted. No image, no OCR text. Only the fields listed in the pipeline, including the receiver name kept on a waiting slip.
- Bilingual UI (Thai primary, English), 44px tap targets, one-handed courtside use (see `PRODUCT.md`).
- Plan gating: gated like the other LINE features (see call 4); the builder reads `docs/2026-10-06-pricing-tiers.md` and `server/src/plans/plan.ts` for how.
- Docs: when this ships, `docs/overview.md` gets a section on slip matching and the changed LINE privacy promise, per the project's CLAUDE.md.
- Server tests run serially (`fileParallelism: false`); engines stay dependency-free and are not touched.

## Risks and unknowns (not yet verified)

- **Image events in groups.** Not confirmed against LINE's reference docs that the bot receives image messages and can download their content.
- **Consent.** LINE sends no user id for members who have not consented to profile access. Those members cannot be linked.
- **Banks.** Tested four. TTB, GSB, KTB, UOB, and any other app are untested. A slip with no readable QR falls to the host prompt.
- **OCR speed and load** on the home server per image, and what happens in a burst of slips right after the bill goes out. Unmeasured; the builder should measure and queue if needed.
- **Phone photos of a screen** will likely fail the QR read. They fall to the host.
- **Forged slips.** An edited image with a valid-format QR and the right amount passes. Mitigation is the visible paid-by-slip label and host undo, not prevention.
- **Another player's slip.** If someone posts a slip that is a real one for a different person's payment (for example a friend's), it can mark the wrong player paid. Mitigated by the amount and mapped-sender rules, not eliminated.
- **Amount collisions.** If two players owe the same amount (common when everyone splits equally) and an unmapped sender posts, the host must choose; the app must not guess.
- **Wrong-recipient slips.** The QR carries no receiver, so the receiver name is read by OCR and compared with the group's saved pay-account name (see open decision 2). Risks: a host who saved a nickname or a different spelling than their bank name never matches, so every slip falls to the host; the Thai OCR language data is larger than English-only and must ship in the container; four slips is a small test, so the tolerance needs more samples (other banks, long names, names wrapped over two lines like the Krungsri slip).
- **Tesseract data and dependencies.** tesseract.js downloads its language data (`eng.traineddata`) at runtime by default. The production container must ship it locally (no CDN fetch on first slip). The server will gain npm dependencies (QR reader, JPEG/PNG decoder, OCR); the disk-cleanup note says disk is tight, so check image size. The `engines/` folder stays dependency-free and is untouched.
- **Spam and large images.** Anyone in the group can post images. Covered by the queue, size cap and per-group limit in the pipeline; the QR check runs before OCR so ordinary photos never reach OCR.
- **Pending slips.** A slip waiting for the host needs its own stored record (reference, sender, amount if read, candidate players, time) until resolved, because the image is gone. If the host never resolves it, it simply stays on the list until dismissed.
- **Player changes.** If players can be deleted or merged, mappings and paid state must follow or be cleaned up. A player may have more than one LINE account (new phone); an account maps to only one player per group.
- **Removing data.** Unlinking the LINE group or deleting a JubBad group already purges stored roster messages (`server/src/line/line-purge.ts`). The new records (seen accounts, account-to-player links, pending slips, duplicate events, references) must be purged the same way. Whether account-to-player links survive an unlink is an open product call, default: purged.

## Open decisions (owner must answer before the plan)

1. **DECIDED 2026-10-30: the privacy promise to the LINE group.** Today the bot tells the group, on `/link`, that it keeps "roster messages only, with who posted them and when, and no other chat", and the code drops everything else (`docs/archive/specs/2026-10-26-line-bot-roster-design.md`). The owner chose to record only accounts that post a slip or a roster. Other messages and other senders stay dropped, so a quiet member appears on the setup screen only after they post a roster or a slip. The `/link` reply, the host's LINE settings page and `docs/overview.md` must say the bot also reads payment slips (kept: who sent it, when, the reference and the amount; the image is not kept). A non-slip image leaves no record at all.
2. **DECIDED 2026-10-30: wrong-recipient check by receiver name.** Every slip prints the receiver's name, so auto-paid also requires the receiver name on the slip to match the name in the group's saved pay account (`Group.payAccount.name`). Tested 2026-10-30 with Thai plus English OCR: the receiver's full name and the last digits (`5953`) were read on all four slips, about 0.5 to 0.7 s per image. **Partial match is enough (owner, 2026-10-30):** the saved name may be shorter than the slip's. Saved `จิตติญา` matches a slip receiver of `น.ส. จิตติญา ฉัตรเฉลิมวิทย์`. The rule: split the saved name into words (titles such as น.ส., นาย, นาง are ignored); every saved word must equal a whole word in the receiver block, not just sit inside a longer word (`นก` is inside `ภัคชนก`, the sender on a tested Bangkok Bank slip, so substring matching is unsafe). A saved name whose words are all very short (about 2 to 3 characters or fewer) is not accepted for auto-matching, and the pay-account settings tell the host to save a longer name. Allow a one-character misread in words of five or more characters. A name saved in English against a Thai slip does not match and falls to the host. The builder sets the exact thresholds and tests them on more slips. **Position matters (owner, 2026-10-30):** on Thai slips the sender is shown first and the receiver below it (true on all four tested: SCB, Bangkok Bank, KBank, Krungsri). The name must be found in the receiver position, the lower of the two name blocks, using the word positions OCR returns, and not just anywhere in the text. Otherwise a slip where the host is the sender (for example the host paying a player back) would match as a payment to the host. Some slips label the blocks (จาก / ไปยัง / ไปที่) and some use only an arrow (KBank, Krungsri), so position is the primary signal and labels are a bonus. Test the host-as-sender case with a real slip. If the name cannot be read, or does not match, the slip goes to the host instead of auto-paying. A group with no saved pay-account name skips the check. The last digits are a possible second signal, builder's call.

## Calls made while writing this (owner to check; not agreed in conversation)

1. **No general amount extraction.** The OCR text is tested against the amounts actually owed: each unpaid player's share (whole-token match). The host prompt shows "amount read" only when exactly one owed amount (or sum) matched. Otherwise it shows "amount not read" and lists all unpaid players. If two unrelated owed amounts both appear in the text, treat it as not matched and send it to the host.
2. **What counts as owed and when slips count.** Slips count from the moment the host confirms the payment card (`confirmedAt`), not from when the bot sees a card in the group, because a LIFF share may not be visible to the bot. While the card is stale (amounts changed since confirming), nothing is auto-marked. If the host changes amounts after a player was auto-marked paid, the paid mark stays but is flagged "amount changed since", so the host decides. A slip posted before any card is confirmed is ignored and not remembered, so an early payer's slip is not matched retroactively; they appear as unpaid and the host ticks them (cash-style), or they repost.
   - **Undo.** Undoing a paid mark keeps that slip's reference recorded, so reposting the same slip shows as a duplicate; the host ticks the player by hand.
   - **Unsend.** If a member unsends the slip message in LINE, nothing changes automatically; the host can undo the mark.
3. **Several unpaid bills in one group.** The matcher looks across every confirmed, unpaid bill in the group, newest first. If a player owes the same amount in two sessions, the slip goes to the host instead of guessing. Transaction references are remembered per group, so one slip can never be accepted twice across sessions.
4. **Plan gating.** Gated like the other LINE features: dormant until plan gating is switched on, and the paid effects (auto-marking, new prompts) stop when a paid plan lapses while recorded marks stay. This follows the owner's 2026-10-26 stance on plan gating.
5. **Notifications.** No push or DM to the host or to players. A badge or count on the bill screen shows slips waiting for attention, including duplicates. The bot never posts in the group, not even "marked paid" or "duplicate slip", to stay clear of the free-account message quota and group noise. (Duplicate handling is the owner's decision, see above.)
6. **Visibility.** Paid status is host-only. The public payment card link, the `/d/:token` dashboard and the session summary page do not show who has paid.
7. **Pre-selection.** A slip from a mapped sender whose own player is not on tonight's bill still pre-selects players who owe the matching amount, but never marks anyone paid without a host tap.

## What is left to the builder

Schema and storage, how the setup screen is reached, wording in Thai and English, the exact text-matching for the OCR amount (for example `172` versus `172.00`, thousands separators), handling of failures and retries when the LINE content download fails, and how the pieces are split into tasks.
