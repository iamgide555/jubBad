# Host self sign-up, with a trial for linking LINE — design

- **Date:** 2026-11-16 (third revision the same day)
- **Branch:** `feat/host-signup`
- **Status:** awaiting owner approval. Nothing is built.

Revision history: (1) one-time link from the bot, LINE required; (2) LIFF
replaces the one-time link; (3) the website door needs no LINE, and the trial
is earned by linking LINE (owner's idea).

## Intent

Today only the platform admin can create a host account (`POST /admin/users`).
A new host cannot start using JubBad without the owner doing it for them, so
the app cannot grow past hosts the owner personally onboards.

This change lets a new host create their own account without the owner's
involvement, and gives them a 30-day trial of the paid features when they
link their LINE account.

## Decisions the owner made

| Decision | Detail |
|---|---|
| Two doors: the JubBad website and the JubBad LINE bot | |
| Website door needs no LINE | Email + password; the account starts on the free plan. |
| Linking LINE for the first time starts a 30-day trial of the paid version | Then it drops to free through the plan-lapse logic already built. |
| The bot shows a menu that depends on who is talking | A guest (no JubBad account linked) sees sign-up and link. |
| Guest menu (2 buttons) first; the host menu comes later | The host menu (ก๊วนของฉัน, รอบวันนี้, บัญชี/แพ็กเกจ) is a separate, later piece of work. |
| The menu buttons open pages through LIFF | Rich menu for the buttons, LIFF for what they open. |

## The one rule

**The trial starts the first time an account gets a LINE link.**

- Sign up on the website: free plan. Link LINE later: trial starts then.
- Sign up from the bot: the account is created already linked, so the trial
  starts at once.
- One trial per LINE account and one per JubBad account, permanently.
  Unlinking and linking again, or linking a different LINE account, earns
  nothing more.
- Only an account on the free plan is given the trial. An existing host
  (today all on `club`, never lapsing) who links LINE keeps exactly what they
  have.

## Goals

- A stranger can go from the website or from the bot to "signed in, naming
  their first group" in one sitting, with no admin step.
- Linking LINE is the obvious next step for a free host, and it is rewarded.
- Login is unchanged: email + password, on any device, no LINE needed.
- Existing hosts and the admin's manual account creation keep working exactly
  as today.

## Non-goals

- The host menu for linked hosts (later).
- Password reset through the bot (later; this design makes it possible).
- One-tap login from LINE. LINE proves who links; it never signs anyone in.
- A marketing landing page. The website door is one plain page.
- Payment, self-service upgrade, or any change to what each plan unlocks.
- Email sending or email verification.

## Anti-goals

- A trial that can be had without a LINE account, or more than once.
- Any push message. Every bot message here is a reply (free).
- Anything posted to, or read from, a LINE group chat. The menu and every
  message below live in the one-to-one chat only.
- An existing host losing anything by linking LINE.

## Constraints found in the code

- `User.plan` defaults to `club`, which is what keeps plan gating dormant for
  existing users. Sign-up must set the plan explicitly; the default must not
  change.
- `User.lineUserId` is unique: one LINE account maps to at most one host.
- The server sends no email. A forgotten password is a request the admin
  handles by hand.
- One LIFF app exists, on a LINE Login channel in the same provider as the
  bot (`docs/line-liff-setup.md`). Its endpoint is `<PUBLIC_APP_URL>/line-share`,
  so every LIFF page lives under `/line-share/...`.
- The server already verifies a LIFF access token and resolves the LINE user
  id (`server/src/sessions/slips/liff-identity.ts`), and the web already wraps
  the LIFF SDK (`web/src/app/core/liff-client.ts`). The slip-pay page uses
  both in production, and its LINE ids match the ones the bot sees.
- The bot already answers the `follow` event with a free reply
  (`FOLLOW_TEXT` in `line-webhook.service.ts`).
- Linking a LINE account today needs the Host plan
  (`LineHostService.createCode` calls `requireGroupPlan(groupCode, 'host')`).
  A free host must be able to link for the trial to be reachable, so the new
  link page has no plan requirement. The code flow keeps its rule.
- `overview.md` records "LIFF / LINE Login is not an identity provider". This
  design narrows that for hosts: a verified LINE identity can be recorded on
  an account, from sign-up or from the link page. It is still never a way to
  log in. `overview.md` must be updated to say so.

## Approaches considered

**Who can sign up, and what earns the trial**

1. **Open website sign-up on free; the trial is earned by linking LINE
   (chosen, the owner's idea).** Lowest barrier, the trial cannot be
   repeated, and it pulls hosts toward linking LINE. Costs: an open form with
   no email check (throttled, with a bot trap), and a web-only host meets the
   free version first.
2. **LINE required to sign up at all.** No open form, and every host starts
   on the trial. Dropped by the owner's idea: it turns away a host who just
   wants to try the website.
3. **Open sign-up with the trial given at once.** Dropped: a new email would
   earn a new trial every time.

**How a page knows which LINE account it is dealing with**

1. **LIFF page with a verified LINE identity (chosen).** The page sends the
   LIFF access token; the server resolves the LINE user id with the check the
   slip-pay page already uses. A menu tap opens the page directly and the
   link never expires. Costs: the page waits if LINE's check is down, and it
   has to prompt the host to add the bot.
2. **One-time link issued by the bot.** Dropped: extra steps for the host,
   links that go stale, and a token table LIFF makes unnecessary.
3. **Stateless signed link.** Dropped: it cannot be made single-use.

**How the guest menu reaches only guests**

1. **Per-user rich menu (chosen).** One guest rich menu is created once. The
   bot links it to a LINE user when it sees they have no JubBad account, and
   it is unlinked when they sign up or link. No default menu is set, so
   linked hosts see no menu until the host menu is built.
2. **Default rich menu for everyone.** Dropped: linked hosts would see "sign
   up" forever.
3. **Quick-reply buttons only.** Dropped: they vanish after the next message.

## The design

### The flows

```
Door 1: website (no LINE needed)
/signup → email + password → account on FREE → signed in → /groups/new
                                   │
                                   ▼ later, whenever they like
              "ผูก LINE รับทดลองฟรี 30 วัน" (home page, upgrade sheet)
                                   │
                                   ▼
              LIFF page /line-share/link → email + password
                                   │
                                   ▼
              LINE linked → TRIAL starts (Host plan, 30 days)

Door 2: bot
Host adds the bot → welcome reply + guest menu:
   [ สมัครใช้ฟรี 30 วัน ]            [ มีบัญชีแล้ว ผูก LINE ]
          │                                  │
          ▼                                  ▼
LIFF /line-share/signup               LIFF /line-share/link
email + password                      email + password of the account
          │                                  │
          ▼                                  ▼
account created, LINE linked,         LINE linked, trial starts if the
TRIAL starts, signed in               account is free and never had one
→ /groups/new                         guest menu removed
guest menu removed
```

### When the trial is given

At the moment a LINE id is attached to an account (sign-up from the bot, or
the link page), the server gives the trial only when all three hold:

1. this LINE id has no trial record,
2. this account has no trial record,
3. the account's effective plan is free (a brand-new bot sign-up counts).

Giving the trial means: `plan = 'host'`, `planRenewsAt` = end of the Bangkok
day 30 days from now (the same end-of-day rule the admin plan form uses), and
a trial record written. Otherwise the link still happens, with no plan
change. When the trial runs out the account reads as free through
`effectivePlan`, with the lapse notices and locks that already exist.

The `/link <code>` flow never gives a trial: it needs the Host plan to get a
code, so a free account cannot reach it.

### What gets linked, and the group's roster switch

Three things sit under ตั้งค่ากลุ่ม > LINE and only the first two are touched
here:

- **The host's LINE account** (`User.lineUserId`, one per account, covers all
  their groups): set by a bot sign-up or by the link page.
- **A group's "รับรายชื่อทางแชต" switch** (`Group.lineDmEnabled`): today off
  for a new group, and switched on for one group by the code flow. Changed so
  a host does not have to visit settings before their first roster:
  - a group created by an owner who has a LINE link and an effective plan of
    Host or above starts with the switch **on**;
  - linking from the link page switches it on for **every** group the account
    already owns, when the effective plan after the trial rule is Host or
    above. With several groups on, the bot already asks which group a roster
    is for.
  Off stays one tap away in settings, and a lapsed plan is handled by the
  existing rules (`PLAN_TEXT`).
- **The bot inside a LINE group chat** (`Group.lineGroupId`, `/link` typed in
  the group): never automatic and not changed. LINE offers no way to do it
  for the host.

### Bot behaviour (one-to-one chat only)

A **guest** is a LINE user id that no `User.lineUserId` holds.

| Event | Guest | Linked host |
|---|---|---|
| `follow` | Welcome reply with a button to the sign-up page; guest menu linked | Today's `FOLLOW_TEXT`, unchanged |
| Types `สมัคร` or `/signup` | Reply with the sign-up button | "มีบัญชีแล้ว" + login link |
| Any other DM text | Existing behaviour (`LINK_FIRST_TEXT` for a roster, etc.); guest menu linked if not yet | Unchanged |
| `/link <code>` succeeds | Guest menu removed | — |
| Host unlinks their LINE account from JubBad | — | Guest menu linked again on their next DM |

Both menu buttons are plain links to the two LIFF pages. All bot text is Thai
only, like the existing bot replies.

### Data (one migration)

```
TrialRecord
  id          cuid
  lineUserId  String  @unique   // this LINE account has had its trial
  userId      String? @unique   // the account that got it; set null if that user is deleted
  createdAt   DateTime

User
  + signupSource  String @default("admin")   // 'admin' | 'web' | 'line'
```

A `TrialRecord` is never deleted. `signupSource` only feeds the admin list;
existing users read as `admin`, which is true. `User.plan`'s default stays
`club`.

### API (all public, all throttled by IP)

- `POST /auth/register` with `{ email, password }` (same rules as
  `CreateUserDto`: valid email, password 8–512 characters), plus a hidden
  trap field that a person never fills: a filled trap gets a normal-looking
  success and creates nothing. Creates a user with `role = 'host'`,
  `plan = 'free'`, `signupSource = 'web'`, sets the session cookie as login
  does. A taken email is `409 EMAIL_TAKEN`.

The three calls below carry the LIFF access token, verified the same way as
the slip-pay page. A token LINE will not confirm is a 401; LINE not answering
is a 503 (never a 404), as the slip page does.

- `POST /auth/line/status` → `{ lineDisplayName, registered, trialAvailable }`:
  whether this LINE account already belongs to a JubBad account, and whether
  it can still earn a trial. The pages use it to choose what to show.
- `POST /auth/line/signup` with `{ email, password }`: refuses if this LINE
  id already belongs to a user (`409 LINE_ALREADY_REGISTERED`). In one
  transaction creates the user (`signupSource = 'line'`, LINE id set) and
  applies the trial rule above; a LINE id whose trial was used before still
  gets an account, on free. Sets the session cookie, unlinks the guest menu
  (best effort; a LINE failure never fails the sign-up). Returns whether the
  trial started and whether the LINE account is a friend of the bot.
- `POST /auth/line/link` with `{ email, password }`: checks the credentials
  exactly as login does (same throttles, same single "wrong email or
  password" answer). Refuses if the account already has a LINE link or the
  LINE id belongs to another account (`409`). Sets `lineUserId` and
  `lineLinkedAt`, applies the trial rule, unlinks the guest menu. No plan
  requirement. It does not sign the browser in. Returns whether the trial
  started and until when.

Two reads change:

- `GET /plans/me` gains `trialAvailable` (the account is on free, has no LINE
  link and no trial record) and `linkUrl` (the LIFF link to the link page,
  null when LINE or LIFF is not configured).
- `GET /auth/signup-info` → `{ lineSignupUrl }` for the website page (null
  when LINE or LIFF is not configured; the page then leaves that option off).

### Web

- `/signup` (public): email, password, submit, and a line under it:
  "หรือสมัครผ่าน LINE รับทดลองฟรี 30 วันทันที" opening the LIFF sign-up page.
  Link to `/login`. On success goes to `/groups/new`.
- `/line-share/signup` (LIFF page): shows the LINE display name, email,
  password, submit. On success: says the trial has started and until when (or
  that this LINE account has had its trial, so the account is on free); if
  not yet a friend of the bot, an "เพิ่มบอทเป็นเพื่อน" button and a
  "ข้ามไปก่อน" link; then `/groups/new`. A LINE account that is already
  registered sees a line and a login button instead of the form.
- `/line-share/link` (LIFF page): shows the LINE display name, email,
  password of the existing account. On success: "ผูกแล้ว", the trial end date
  if one started, and how to send a roster to the bot.
- **The offer to a free host.** While `trialAvailable` is true, the landing
  page shows one line with a button, "ผูก LINE รับทดลองฟรี 30 วัน", and the
  upgrade sheet leads with the same offer above the contact. Both open the
  link page. Not shown on the live dashboard, like the other plan notices.
- `/login`: one added line, "ยังไม่มีบัญชี? สมัครใช้ฟรี", linking to `/signup`.
- Thai source text with English as the second locale, as everywhere else.

The link page opens in LINE's own browser, where the host is usually not
signed in to JubBad, which is why it asks for the email and password instead
of relying on a session.

### Admin

The `/admin` user list shows where each user came from (ผู้ดูแลสร้าง / เว็บ /
LINE) and whether they have had their trial. The plan and renewal date are
already shown and editable there.

### Guest rich menu

- One image, two buttons side by side, Thai text baked in. The look is the
  owner's to approve before it is uploaded; a mockup comes with the build.
- Created once by a script in `server/scripts/` (create the menu with its two
  links, upload the image, print its id). The id goes in a new env var,
  `LINE_GUEST_RICHMENU_ID`. With the variable unset the bot skips every menu
  call and everything else still works.
- `LineClient` gains "link rich menu to user" and "unlink rich menu from
  user". Both are best effort and never block a reply.

## Builder's calls (not asked; correct any of these)

1. **Trial plan is `host`, not `club`.** Host unlocks every feature; club only
   adds a higher group cap (10 instead of 3). A trial host who made 5 groups
   on club would find 4 paused the day the trial ends.
2. **The trial is given only to an account on the free plan.** This is what
   keeps existing hosts untouched. It also means a host the admin has put on
   a paid plan does not get 30 days added by linking.
3. **Spam protection on the open form is an IP throttle and a hidden trap
   field, no captcha.** A free account gets one group and no paid features,
   so the damage a fake account can do is small. Add a captcha only if junk
   accounts actually appear.
4. **An email is not checked to be real.** A host who mistypes theirs can
   still log in with what they typed; a reset then goes through the admin as
   today.
5. **The link page links by email + password**, not by a code. The
   `/link <code>` flow stays as it is, including its Host-plan rule.
6. **Players who add the bot also see the guest menu.** The bot cannot tell
   a player from a new host. The welcome text and the button say
   "สำหรับหัวก๊วน". This may even bring in players who run another ก๊วน.
7. **No notice to the owner when someone signs up.** That would be a push
   message. The owner sees new hosts in `/admin`.
8. **No terms-of-use line on the forms.** No terms document exists yet.
9. **"Email taken" is said plainly on the forms**, as `POST /auth/forgot`
   already answers plainly by the owner's earlier decision. With an open form
   this does let someone test whether an email has an account; the throttle
   limits how fast.
10. **The add-friend prompt after a bot sign-up can be skipped.** The account
    works without it; only roster-by-DM and the share card need the bot as a
    friend.

11. **A linked host's new group starts with "รับรายชื่อทางแชต" on**, and the
    link page switches it on for all the account's groups. This applies to
    every linked host, the owner included, not only self-signed ones.

## Left to the builder

- Exact Thai wording of the bot replies and the pages.
- Whether the welcome reply is plain text with a URL or a card with a button.
- How "already has the guest menu" is remembered so the bot does not call
  LINE on every DM (an in-memory set is enough; it may reset on deploy).
- Throttle limits for the new routes, in line with `LoginThrottle` and
  `slip-throttles.ts`.
- Whether `liff-identity.ts` moves out of `sessions/slips/` now that auth
  uses it too.
- The rich menu's exact size and tap areas, checked against LINE's current
  Messaging API documentation before the script is written.
- Tests: web register creates a free user and leaves the `club` default
  alone for admin-created users; the trap field; the trial rule's three
  conditions, each failing on its own (LINE id used, account used, account
  not on free); unlink and re-link earns nothing; trial end date on the
  Bangkok day; the 401/503 split when LINE refuses or is silent;
  link-by-password (wrong password, already linked, LINE id taken); the
  roster switch (on for a linked Host-plan owner's new group, off for an
  unlinked or free owner's, on for all groups after a link that starts the
  trial); bot
  routing for guest vs linked; and that a LINE menu failure never fails
  sign-up or linking.

## Deploy steps (for later)

1. Apply the migration.
2. Run the rich menu script once on the server; set
   `LINE_GUEST_RICHMENU_ID`.
3. Confirm `LINE_BOT_ADD_URL`, `PUBLIC_APP_URL`, `LINE_LIFF_ID` and
   `LINE_LOGIN_CHANNEL_ID` are set (all already are, for the share card and
   slip pages). No LINE console change is expected: the new pages sit under
   the existing LIFF endpoint and need only the `profile` scope already on.
4. Real checks with a second LINE account and a fresh email:
   website sign-up lands on free with the offer showing; linking starts the
   trial and the offer disappears; bot sign-up starts the trial at once and
   the menu disappears; unlink and re-link gives no second trial; the owner's
   own account is unchanged after all of it.

## Docs to update when built

- `docs/overview.md`: the "No LIFF / LINE Login" and "Per-user accounts" rows
  of the decision table, the out-of-scope list, the "Plans" section (how a
  trial starts, `trialAvailable`), the LINE bot section (guest menu, sign-up,
  link by password), and the route list.
- `docs/2026-10-06-pricing-tiers.md`: the trial.
- `CLAUDE.md`: the route list (`/signup`, `/line-share/signup`,
  `/line-share/link`).
- `docs/line-liff-setup.md`: the two new LIFF pages and the rich menu script.
