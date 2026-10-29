# LINE LIFF setup (host share card)

One-time setup by the owner, in the LINE Developers console and on the home server. Design and
rules: `docs/superpowers/specs/2026-10-28-line-host-share-card-design.md` and the "LINE bot"
section of `docs/overview.md`.

What this turns on: when a group has no bot in its LINE group but the host linked their own LINE
account by DM, ending a session DMs the host the summary card with a "ส่งเข้ากลุ่ม" button. The
button opens a small page inside LINE (a LIFF app); the host picks a group and LINE sends the card
from the host's own account. Until this setup is done and `LINE_LIFF_ID` is set, that DM is simply
not sent and nothing else changes; groups with the bot in the LINE group keep working as before.

The same LIFF app also carries the payment card (ใบเก็บเงิน, design:
`docs/superpowers/specs/2026-10-29-line-payment-card-design.md`): a host-share group opens
`https://liff.line.me/<LINE_LIFF_ID>/pay/<code>/<token>` to send it. It needs no new LIFF app, no new
endpoint and no new environment variable; its checks are in "Payment card checks" below.

You need: the LINE Developers console login that owns the bot's Messaging API channel, and SSH to
the home server.

## 1. Create a LINE Login channel

1. Open the LINE Developers console and pick the **same provider** that holds the bot's Messaging
   API channel. (A LIFF app must live on a LINE Login channel; keeping it in the bot's provider
   keeps the user ids the same, so a host is one person across both.)
2. Create a new channel, type **LINE Login**. Any name works (for example "JubBad share"). Region
   and category are not important.
3. Nothing else on the channel needs configuring for this feature.

## 2. Add the LIFF app

On the new LINE Login channel, open the **LIFF** tab and add an app:

- **LIFF app name:** anything, for example "JubBad share".
- **Size:** Full.
- **Endpoint URL:** `https://jubbad.wongnok.dev/line-share` (this is `<PUBLIC_APP_URL>/line-share`,
  with no trailing slash and no session code; LIFF appends the code itself).
- **Scope:** leave the default; the page reads nothing from the host's profile.

Save. The console shows a **LIFF ID** (looks like `1234567890-AbCdEfGh`) and a LIFF URL
(`https://liff.line.me/<LIFF ID>`). Copy the LIFF ID.

**Then enable the share target picker (do not skip).** It is a setting of the LINE Login channel,
not of the LIFF app. On the channel's **LIFF** tab, click **shareTargetPicker**, read the Agreement
Regarding Use of Information, tick **I have read and agree**, and click **Enable**. Until this is
done, `liff.isApiAvailable('shareTargetPicker')` is false and the page says it cannot share from
here (verified on the real LIFF app 2026-10-29: enabling it made the picker work on a phone, in
the LINE app).

## 3. Publish the LINE Login channel (do not skip)

A new channel is in **Developing** status. UNVERIFIED in this session (confirm in the console):
while a channel is Developing, only the channel's own admins and testers can open its LIFF app, so
every other host would be refused. Switch the channel to **Published** (the status switch at the top
of the channel page) before real hosts use it.

If you would rather test first, keep it Developing and add the test hosts as testers on the channel;
publish before telling other hosts.

## 4. Put the LIFF ID on the server and restart

On the home server (`ssh "${HOME_SERVER_USER}@${HOME_SERVER_IP}"`), edit `server/.env` in the
jubBad project and add:

```
LINE_LIFF_ID=<the LIFF ID from step 2>
```

`PUBLIC_APP_URL` must also be set (for example `https://jubbad.wongnok.dev`, no trailing slash); the
card's "ดูสรุป" button and the LIFF endpoint both depend on it. The bot's `LINE_CHANNEL_SECRET` and
`LINE_CHANNEL_ACCESS_TOKEN` must already be set. **Without both `LINE_LIFF_ID` and `PUBLIC_APP_URL`
the host target is off**: no DM card, no share page, no host settings switch, and the share-card
endpoint answers 404.

Then restart the API so it reads the new value. There is no migration in this release, but follow
the usual flow in `dockerDeploy.md` (run `npm run db:backup` first, then deploy / restart). The web
image carries the new `/line-share` page, so deploy the web service too.

## 5. Real-LINE check

Do this with a test group that is **not** linked to a LINE group chat, with the host's LINE linked
by DM and that group's DM switch on (settings, LINE page, "แชตส่วนตัวกับบอท" card). Finish a session
with at least one finished game and leave the "ส่งการ์ดสรุปให้ฉันทาง LINE" box ticked.

- [ ] The summary card arrives as a DM from the bot, with two buttons: "ดูสรุป" first, then
      "ส่งเข้ากลุ่ม".
- [ ] Phone, in the LINE app: tap "ส่งเข้ากลุ่ม". The page opens inside LINE with no login step and
      shows a preview of the card.
- [ ] Tap "เลือกกลุ่มแล้วส่ง": the share picker opens, pick a group, and the card is sent from the
      host's own account. The page shows "ส่งแล้ว" and offers to send elsewhere.
- [ ] Closing the picker without sending leaves the page as it was, with no error.
- [ ] iPad / external browser: open the same button (or the "ส่งการ์ดเข้ากลุ่ม LINE" link on the
      summary page). LINE Login appears (email and password, or phone QR), then it returns to the
      page and the picker works. If the browser cannot open the picker, the page says to open it in
      the LINE app.
- [ ] Send to a LINE group that already has another bot (for example ขุนทอง). It works, because
      the host is the sender.
- [ ] In the group: the card looks right (group, date, venue, players, games) and "ดูสรุป" opens the
      public summary page.
- [ ] The first-redirect form works: LIFF first opens
      `https://jubbad.wongnok.dev/line-share?liff.state=%2F<sessionCode>`; confirm the page lands on
      the right session (not "not found") on a fresh open of the LIFF URL
      `https://liff.line.me/<LINE_LIFF_ID>/<sessionCode>`.
- [ ] A host who is **not** an admin or tester of the LINE Login channel can open the LIFF app.
      This is the published-channel check from section 3: if that host is refused, the channel is
      still Developing.
- [ ] DM switch off on an unlinked group: ending a session sends no DM card. (The host settings
      switch is still shown here, so it can be turned back on.)
- [ ] Group linked to a LINE group (bot in the chat): the card still posts into that group and no
      DM is sent. The host settings switch is hidden for a bot-linked group.
- [ ] Paused group (plan lapsed): no card of either kind is sent. The host settings switch is
      hidden for a paused group.
- [ ] Only one DM per session: once the DM is delivered the summary page offers no resend, so a
      second card cannot be sent from there; the "ส่งการ์ดเข้ากลุ่ม LINE" link remains.

The LIFF page is served from the Thai (root) build only, so its English strings are never shown to
LINE users: nginx serves English under `/en/`, and the LIFF endpoint is `<PUBLIC_APP_URL>/line-share`.

Also check the card's layout once in LINE's Flex Message Simulator if it looks off on a device.

## Payment card checks

Run these after the payment card is deployed (branch `worktree-feat-line-payment-card`). Use a test
group with a Host-plan owner, and the host's LINE linked by DM for the host-share checks. Make a
session with at least a few finished games and a ready bill (court fee, shuttle count and price set),
then end it.

**Deploy notes.**
- One new migration, `20261029000000_line_payment_card` (two nullable columns, `Group.payAccount` and
  `Session.paymentCard`, no backfill). Take `npm run db:backup` first, and check for other
  undeployed migrations **before** rebuilding, not after.
- No new environment variables. The host-share link uses the existing `LINE_LIFF_ID` and
  `PUBLIC_APP_URL`. The web image carries the new `/line-share/pay/:code/:token` page, so deploy the
  web service as well as the API. Follow `dockerDeploy.md`.

- [ ] Group settings, "บัญชีรับเงิน": the bank list opens on focus and is searchable ("kbank" and "กส"
      both find กสิกร); a bank typed by hand that is not in the list also saves; save, reload, the
      fields come back.
- [ ] Host-share group: end a session with the new "ส่งใบเก็บเงินด้วย" tick on. The summary page opens
      with the payment sheet over it. Confirm. "เปิดใน LINE เพื่อส่ง" opens the page inside LINE; pick
      a group and send. The card shows every person's amount, the total and the account, and a
      plain-text message with only the account number follows it.
- [ ] Tap the card's copy button on a phone: the number is copied (paste it somewhere to check). On
      LINE Desktop the button does nothing by design (spike 2026-10-29); the plain-text message
      right after the card is how a desktop reader copies the number.
- [ ] Same on a group that already has another bot (for example ขุนทอง).
- [ ] Host-share group, DM button: confirm, then tap "ส่งการ์ดให้ฉันทาง LINE" (try it from a computer
      or iPad). The card arrives from the bot in the owner's own LINE chat with both the copy button
      and a "ส่งเข้ากลุ่ม" button; "ส่งเข้ากลุ่ม" opens the LIFF page and the picker sends it. The
      panel says "ส่งการ์ดให้คุณใน LINE แล้ว ..." with the time, and a second tap asks first. Block
      the bot (or remove the friend) and tap again: the panel reports the failure and says to add the
      bot as a friend again.
- [ ] Bot-linked group: confirm, then "ส่งเข้ากลุ่ม" posts the card into the LINE group, with the
      number message after it. The copy button renders and works in the bot-sent card. If the button
      fails there nothing else is needed, since the text message follows; if the extra message matters
      for the push quota, set `PAYMENT_NUMBER_TEXT.group` to `false` in
      `server/src/line/payment-card.ts` and redeploy. Note whether the group's quota went down by one
      message or by one per member (unverified until now).
- [ ] Bot-linked group: the panel then says "ส่งแล้ว <time>" and the button reads "ส่งอีกครั้ง"; tapping
      it asks first ("ส่งการ์ดเข้ากลุ่มซ้ำอีกรอบใช่ไหม"), and "ใช่ ส่งเลย" posts a second card.
- [ ] Edit the bill after confirming so an amount changes: the panel says "ยอดเปลี่ยน, ยืนยันใหม่" and
      send and the LIFF link are gone until you confirm again. After the re-confirm, the **old** LIFF
      link shows the "not found" page.
- [ ] Open the bill in two tabs, change an amount in one, then press Confirm in the other without
      reloading: confirm is refused with the changed-amounts message ("ยอดเปลี่ยน ตรวจยอดอีกครั้ง"),
      the panel shows the new amounts, and nothing was stored until you confirm again.
- [ ] Skip the tick, or close the sheet: the summary page still shows the "ส่งใบเก็บเงินเข้ากลุ่ม"
      banner and it opens the panel; the bill screen shows the same panel inline.
- [ ] No account set anywhere: confirm is disabled and the panel points to group settings.
- [ ] A group with no LINE link, or whose owner's plan has lapsed: no panel on the bill screen and no
      tick in the จบรอบ dialog.
- [ ] A night with nothing to collect (everyone removed, or every amount 0): the panel says
      "ไม่มีใครต้องจ่าย", offers no confirm or send, and the summary page shows no banner.
- [ ] On a phone, the sheet's close buttons both work: "ปิด" at the top stays visible while a long
      list scrolls (the sticky header is untested in CI), and "ปิด" at the bottom closes it.
- [ ] The public summary page, the display (`/s/<code>/display`) and the group dashboard
      (`/d/<token>`) show no amount and no account number.

## 6. If something is wrong

- **No DM card at all:** the host target is off. Check `LINE_LIFF_ID` and `PUBLIC_APP_URL` are in
  `server/.env` and the API was restarted; the group is not linked to a LINE group (a linked group
  posts into the chat instead); the group's DM switch is on; the owner is on Host plan or higher;
  the session has a finished game.
- **The button opens an error or "no permission":** the LIFF endpoint URL does not match
  `<PUBLIC_APP_URL>/line-share`, or the channel is still Developing and the viewer is not a tester.
- **The page says it cannot share:** the share target picker is not enabled on the LINE Login
  channel (LIFF tab, **shareTargetPicker**, section 2), or the viewer's LINE app is too old, or the
  viewer is in a plain browser. Open the button from an up-to-date LINE app.
- **The page says the summary was not found (404):** the session is not ended, has no finished game,
  or the group is not on the host target any more. The page works only for the host target.
- A host who blocked or unfriended the bot cannot be DMed; the end-of-session dialog reports the
  failure and suggests adding the bot as a friend again.
- **The host-share payment link says not found:** the card changed since the host confirmed it, or the
  link is an old one (every confirm makes a new link). Confirm again in the panel and use the new
  "เปิดใน LINE เพื่อส่ง" button. Also check the session is ended, the group is still on the host
  target (not linked to a LINE group, the DM switch on, the plan not lapsed), and that
  `LINE_LIFF_ID` and `PUBLIC_APP_URL` are set.
- **The panel shows no confirm or send, only a list of what is missing:** the bill is not ready (court
  fee, shuttle count or price). Fix it on the bill screen; the card never shows a provisional amount.
- **The card's copy button does nothing:** expected on LINE Desktop. On a phone, copy the number from
  the plain-text message that follows the card.
