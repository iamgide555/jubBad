# LINE LIFF setup (host share card)

One-time setup by the owner, in the LINE Developers console and on the home server. Design and
rules: `docs/superpowers/specs/2026-10-28-line-host-share-card-design.md` and the "LINE bot"
section of `docs/overview.md`.

What this turns on: when a group has no bot in its LINE group but the host linked their own LINE
account by DM, ending a session DMs the host the summary card with a "ส่งเข้ากลุ่ม" button. The
button opens a small page inside LINE (a LIFF app); the host picks a group and LINE sends the card
from the host's own account. Until this setup is done and `LINE_LIFF_ID` is set, that DM is simply
not sent and nothing else changes; groups with the bot in the LINE group keep working as before.

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
