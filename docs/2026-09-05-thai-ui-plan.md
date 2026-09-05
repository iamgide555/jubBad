# Thai UI (B1) — implementation plan

**Goal:** Make Thai the default language of the app, with English available as
a second locale, using `@angular/localize`. Closes B1 in
`docs/2026-09-05-review-and-v2-backlog.md` — the largest gap between what
`docs/overview.md` says the product is and what it currently is.

**Status:** all seven tasks implemented; 164 tests green (40 engine, 49 server,
75 web), both packages building, locale routing verified in a real nginx
container. Two manual checks below still need a human — move to
`docs/active/plans/` once those pass on a real phone.

## Decisions

- **Source locale is `th`.** Templates are authored in Thai; English is the
  *translation* (`messages.en.xlf`). This is what makes Thai genuinely the
  default — no redirect, no fallback chain, and the untranslated build is
  already the one we want to ship.
- **URL layout: Thai at `/`, English at `/en/`.** Angular emits
  `dist/web/browser/<locale>/`; `en` gets `baseHref: "/en/"`. nginx serves the
  `th` directory at the root and the `en` directory under `/en/`.
- **Server error messages are Thai too.** Several reach the host verbatim
  (`endSessionError` renders `err.error.message`), so leaving them English
  would put two languages on the one screen the host actually reads.
- **Tests assert Thai.** Specs run against the source locale, so every
  assertion currently matching English text changes to the Thai string.

## Global constraints

- No change to engine or business logic. This is presentation only, plus the
  one bug fix in Task 1.
- The stats table's "This session" / "All-time" toggle keeps its existing
  behaviour; only its labels change.
- Player names are user data and are never translated.

## Copy — needs your review before Task 3

This is the part I can't verify. I've translated for a Thai badminton group
rather than word-for-word — notably **ก๊วน** for "session", since that is what
these groups actually call themselves, where จบเซสชัน would read as software.
Correct anything that sounds wrong; the rest of the plan is mechanical.

### Landing

| English | Thai |
|---|---|
| Pair up. Play more. | จับคู่ง่าย เล่นได้เยอะ |
| Paste a roster, get fair doubles pairings, run the night from your phone. | วางรายชื่อจากไลน์ จัดคู่ให้อัตโนมัติ คุมก๊วนได้จากมือถือ |
| Start a new group | สร้างก๊วนใหม่ |

### Court panel

| English | Thai |
|---|---|
| Court {n} | คอร์ท {n} |
| Idle | ว่าง |
| Start next match | เริ่มแมตช์ถัดไป |
| Reshuffle | สุ่มใหม่ |
| Confirm | ยืนยัน |
| Not enough players waiting. | ผู้เล่นไม่พอ |
| No one waiting to sub in. | ไม่มีคนสำรองให้เปลี่ยน |
| {A} & {B} won | {A} & {B} ชนะ |
| No result | ไม่มีผล |
| Session ended | จบก๊วนแล้ว |
| Swap out {name} *(aria-label)* | เปลี่ยน {name} ออก |
| Team A score / Team B score *(sr-only)* | คะแนนทีม A / คะแนนทีม B |

### Dashboard

| English | Thai |
|---|---|
| Waiting | รอคิว |
| Waitlist | สำรอง |
| End session | จบก๊วน |
| Session ended. | จบก๊วนแล้ว |
| Session not found. | ไม่พบก๊วนนี้ |
| Could not end the session. | จบก๊วนไม่สำเร็จ |

### Group entry

| English | Thai |
|---|---|
| Please enter a group name first. | กรุณาใส่ชื่อก๊วนก่อน |
| Paste a roster message first. | วางข้อความรายชื่อก่อน |
| No players were recognized — check that each name is on its own numbered line (e.g. "1. name"). | ไม่พบรายชื่อผู้เล่น — ตรวจว่าแต่ละชื่ออยู่บรรทัดของตัวเองและมีเลขนำหน้า (เช่น "1. ชื่อ") |

### Stats table

| English | Thai |
|---|---|
| This session | ก๊วนนี้ |
| All-time | ทั้งหมด |
| Played | เล่น |
| Won | ชนะ |

### Server messages

| English | Thai |
|---|---|
| Finish all active courts before ending the session. | จบแมตช์ในคอร์ทที่ยังเล่นอยู่ก่อนจบก๊วน |
| This session has ended. | ก๊วนนี้จบแล้ว |
| This match has already started. | แมตช์นี้เริ่มไปแล้ว |
| This match has already finished. | แมตช์นี้จบไปแล้ว |
| Confirm this match before finishing it. | ยืนยันแมตช์ก่อนบันทึกผล |
| Only a pending pairing can be swapped. | เปลี่ยนตัวได้เฉพาะแมตช์ที่ยังไม่ยืนยัน |
| Player is not in this pairing. | ไม่มีผู้เล่นคนนี้ในแมตช์ |

## Tasks

### - [x] Task 1: Surface API errors in the court panel

A prerequisite bug fix, not i18n. The 409 guards added in `63a6b83`
(`confirm`, `finish`, `propose` on an ended session) are not surfaced:
`CourtPanel.confirm` and `.finish` call the service with no catch, so a
rejected request resets `busy` and shows the host **nothing**. Before those
guards existed the calls could not fail this way, so this is a regression
introduced with them.

- Modify: `web/src/app/core/live-session.service.ts` — have `confirmMatch` and
  `finishMatch` return a result object carrying the server message, matching
  the shape `endSession` already uses.
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` —
  an `actionError` signal, set on failure, cleared at the start of the next
  action.
- Modify: `court-panel.html` — render it in the existing `.hint` style.
- Test first: a spec that flushes a 409 from `/confirm` and asserts the
  message reaches the DOM.

Do this before the i18n pass so the string exists to be translated.

### - [x] Task 2: Add and configure `@angular/localize`

- `npm --prefix web install @angular/localize`
- `web/src/main.ts` — add the `@angular/localize/init` import (must be first).
- `web/tsconfig.app.json` — add `"types": ["@angular/localize"]`.
- `web/angular.json` — add to the `web` project:
  ```json
  "i18n": {
    "sourceLocale": "th",
    "locales": { "en": { "translation": "src/locale/messages.en.xlf", "baseHref": "/en/" } }
  }
  ```
  and `"localize": true` on the production build configuration.
- Verify: `npm --prefix web run build` still succeeds (no strings marked yet).

### - [x] Task 2b: Thai webfont and vertical metrics

**Neither current font can render Thai.** `web/src/index.html` loads only
Inter and Archivo, both Latin-only, so every Thai string would silently fall
back to whatever Thai face the device happens to default to — different on
iOS, Android and desktop, and metrically unmatched against the Latin digits
sitting beside it in the score row and court numbers.

- Load **Noto Sans Thai** (400,500,600,700,800) from the existing Google Fonts
  link. One Thai family covering both roles rather than two: fewer webfont
  bytes on venue wifi, one consistent Thai texture, and its 400-800 range
  answers both Inter's body weights and Archivo's 700/800 display weights.
- Font stacks become, in `src/styles.css` and the four component files that
  restate them: `'Inter', 'Noto Sans Thai', system-ui, sans-serif` for body,
  `'Archivo', 'Noto Sans Thai', system-ui, sans-serif` for headings, the court
  number, and the score row. Per-character fallback means Latin still renders
  in Inter/Archivo; only the Thai characters come from Noto.
- Vertical metrics: Thai stacks vowel and tone marks above and below the
  baseline, so anything with a tight line-height clips. Audit `line-height: 1`
  in `session-display.css` (`.court-number`) and any equivalent, and raise
  body line-height for Thai runs to ~1.6.
- Thai has a smaller apparent x-height than Latin at the same size, so the
  display view may need a size bump to stay readable across a hall.

Verify by rendering the display view with real Thai names at a laptop's
width and again scaled up, checking no mark is clipped and nothing reflows.

### - [x] Task 3: Translate templates and mark them for extraction

Seven templates, 290 lines total. For each user-facing string: replace the
English with the Thai from the copy table above and add an `i18n` attribute
(`i18n-aria-label` / `i18n-placeholder` for attributes).

- `pages/landing/landing.html`
- `pages/group-entry/group-entry.html`
- `pages/session-dashboard/session-dashboard.html`
- `pages/session-dashboard/court-panel/court-panel.html`
- `pages/session-dashboard/stats-table/stats-table.html`
- `pages/session-display/session-display.html`
- `app.html`

Update every spec asserting English DOM text — at minimum `court-panel.spec.ts`
(`'Session ended'`, `'Start next match'`, `'No result'`, `'... won'`),
`session-dashboard.spec.ts`, `landing.spec.ts`, `session-display.spec.ts`.

`web/src/index.html` also needs `<html lang="th">`.

### - [x] Task 4: Translate the TS-side strings

Wrap in `$localize` and translate:

- `group-entry.ts` — the two `pasteError` strings and the no-players message.
- `court-panel.ts` — the `actionError` fallback from Task 1.
- `session-dashboard.ts` / `live-session.service.ts` — the
  `'Could not end the session.'` fallback.

### - [x] Task 5: Translate the server messages

- `server/src/sessions/sessions.service.ts` — the six `ConflictException` /
  `NotFoundException` messages in the copy table.
- Update `sessions.controller.spec.ts`, which asserts
  `toContain('Finish all active courts')`.

No i18n machinery server-side: there is one audience and one language.

### - [x] Task 6: Generate the English translation file

- `npm --prefix web run ng -- extract-i18n --output-path src/locale`
- Copy to `src/locale/messages.en.xlf` and fill every `<target>` with the
  English from the copy tables (i.e. the strings being replaced in Task 3).
- Verify: `ng build --localize` emits `dist/web/browser/th/` and
  `dist/web/browser/en/`.

### - [x] Task 7: Serve both locales

- `web/Dockerfile` — the copy step currently takes `dist/web/browser`; it now
  contains per-locale subdirectories, so the nginx root moves to the `th`
  directory and `en` is mounted alongside.
- `web/nginx.conf` — add a `location /en/` serving the `en` directory with its
  own `try_files ... /en/index.html`, keeping `location /` on `th`. The
  existing `/api/` block is unchanged and must stay ahead of both.
- Verify per `dockerDeploy.md`: build both images, bring the stack up, confirm
  `/` is Thai and `/en/` is English, and that a deep link like
  `/en/s/<code>` still resolves through `try_files`.

## Manual verification

Checked already, with headless Chrome against the running stack and a seeded
session of real Thai names (ตั้ม, เบสท์, ปอมมี่, ไม้, เกียร์, ซัน, ไบรท์, บูมเมอร์):

- Landing, dashboard and display all render Thai, with no clipped vowel or
  tone marks — including `ก๊วนแบดอังคาร` in the display header, where the ๊ sits
  above the cap line and was the specific clipping risk.
- Noto Sans Thai is served with the Thai unicode-range and answers every Thai
  character; Latin digits in court numbers and scores still come from Archivo.
- Locale routing in a built nginx container: `/` is Thai with `lang="th"` and
  `base href="/"`, `/en/` is English with `lang="en"` and `base href="/en/"`,
  and deep links (`/s/<code>`, `/en/s/<code>/display`) both return 200 and load
  their own locale's bundle. The English bundle contains no Thai UI strings.

Still needs a human:

1. **On a real phone.** Headless Chrome lays out at a fixed width regardless
   of `--window-size` (the wrap point was identical at 375px and 430px), so the
   narrow-viewport layout is the one thing these screenshots could not verify.
   Check the dashboard and court panels at phone width.
2. **On the actual venue screen**, from across the hall. The display view reads
   well at 1600px in a screenshot, but only the real projector settles whether
   Thai at this size carries far enough.

## Risk

Thai text is taller than Latin at the same font size, and the display view
(`session-display.css`) is tuned for cross-room readability. Task 3 may need a
font-size or line-height adjustment there; that is expected, not scope creep.
