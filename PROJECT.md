# Badminton court pairing app

## 1. Opportunity

Existing apps (Racket Social, Kiki-match, Badminton Match Manager, Qcourt,
GroupSlam, etc.) already solve fair doubles pairing, rotation, sit-out
balancing, and cost splitting — well. Not worth rebuilding.

The gap: **nothing is Thai-language + LINE-friendly + PromptPay-native**
for casual Thai badminton groups. Existing pairing apps are English-first,
generic multi-sport tools with their own account/PWA/bot ecosystems.
Existing Thai badminton apps (e.g. Lenkila) are court-booking/partner-finding
marketplaces, not session-running tools for an existing regular group.

The differentiator is localization + fitting into how these groups already
coordinate (LINE group chat, PromptPay for splitting bills) — not a
smarter pairing algorithm.

## 2. Key product decisions (and why)

| Decision | Why |
|---|---|
| No bot in the LINE group chat, ever | A posting bot notifies people who aren't even playing that day — spammy |
| No passive "listener" bot | Even listen-only, it technically sees the *entire* conversation; host's consent doesn't cover the other ~15-20 people in the chat. Bigger trust risk than the convenience is worth for a casual friend group |
| Import is paste-based | App's data footprint = exactly what the host explicitly hands over. No infra (no webhook server, no persistent message store) |
| No LIFF / LINE Login / LINE platform integration in v1 | Paste-based import + manual share means zero technical touchpoint with LINE's platform is needed. Pure UX polish, addable later |
| No login/auth in v1 | Groups identified by shareable link/code instead of accounts. Removes a whole feature surface |
| Score logging: final score only, no live scoreboard | Point-by-point/serve-indicator/timers is scope creep nobody asked for. Final score per court is low-friction and still bootstraps match-history data for future skill/Elo balancing |
| No host role — anyone with the link can edit (**accepted risk**) | No auth means the link doesn't distinguish host from player. Acceptable for a trusted friend-group context; add a host role later only if abuse becomes real |
| No data-retention/deletion policy in v1 (**accepted risk**) | Names persist indefinitely under a group's link code. Revisit if group turnover or privacy requests make it necessary |

## 3. v1 feature set

1. **Import from LINE (paste-based)** — host pastes the roster message
   text; app parses date/time, court count, main roster, waitlist
   (สำรอง) separately. Fuzzy-matches names against known players and
   flags new/unmatched names for host confirmation. Nothing is
   auto-committed without host review.
2. **Roster + shuffle** — host reviews/edits the imported (or manually
   entered) list, sets court count, taps shuffle.
3. **Fair pairing engine** — random doubles pairing that avoids repeat
   partners and balances sit-outs, with history tracked per group across
   sessions (not just within one session).
4. **Manual sharing** — host views results in-app, shares manually
   (screenshot, or "copy as text" button). No bot, no auto-posting.
5. **Cost splitting** — host enters court + shuttlecock fees, app splits
   per person and generates a PromptPay QR to share with just that
   session's players. Requires the host's PromptPay ID/phone stored on
   `Group` (see schema).
6. **Match result logging** — after a round, host optionally enters
   final score per court (e.g. "21-15"), stored against the pairing
   record. No live scoreboard.

**Known-but-not-designed-yet, expected to come up fast once real
sessions run:** mid-session edits — reshuffle after a round has
started, add a late arrival, remove a no-show.

## 4. Explicitly out of scope for v1

- Skill/Elo-based match balancing
- Multi-sport support (badminton-only, Thai-only — that's the moat)
- Any LINE bot (posting OR passively listening)
- LIFF / LINE Login
- User accounts / login
- Live point-by-point scoreboard

## 5. Tech stack

- **Frontend:** Angular (plain web app, no LIFF wrapper for v1)
- **Backend:** NestJS — parsing logic, pairing/rotation engine,
  PromptPay QR generation (EMV QR spec)
- **DB:** relational

```
Group        — id, name/link-code (no user auth), hostPromptPayId
               (phone/ID for QR generation — required for cost-splitting)
Player       — id, groupId, name, aliases[] (fuzzy-match targets;
               populated when host confirms an unmatched import name
               maps to an existing Player)
Session      — id, groupId, date, courtCount, rawImportText (kept for
               parser debugging)
Round        — id, sessionId, roundNumber
Pairing      — id, roundId, courtNumber, teamA[2 playerIds],
               teamB[2 playerIds], scoreA, scoreB (nullable)
Waitlist     — id, sessionId, playerId, position
```

## 6. Core engines — design notes

### 6.1 LINE roster-message parser — **built** (`parser.ts`)

Parses a LINE badminton-session roster message (Thai format) into
structured data: header (date, time slots, court count/numbers, venue),
main roster, waitlist. Source: `src/parser.ts`. Verified against 3 real
example messages from the user's actual LINE groups: `src/test-examples.ts`.

Design principles:
- **Lenient, not strict** — heuristic parsing; real messages vary in
  spacing, punctuation, trailing whitespace on empty slots.
- **Never silently drop or guess** — anything ambiguous (e.g. 2-digit
  year, Buddhist vs. Gregorian) goes to a `warnings` array; anything
  unclassifiable (หมายเหตุ notes) goes to `unrecognizedLines`, never
  discarded.
- **Empty numbered slots preserved** (`3.` → `{position: 3, name: null}`)
  so slot counts stay accurate before names are filled in.
- **`@All`/`@all` excluded from venue detection** — looks like an
  `@venue` tag syntactically but means something different.

### 6.2 Fuzzy-match layer — **built** (`fuzzy-match.ts`)

Parsed roster/waitlist names → known `Player` records for the group.

**Algorithm:** normalized Levenshtein, no auto-link on a fuzzy match —
only on exact match. Reasoning: Thai nicknames here run 2-4 chars
(ปอม, ตี๋, เบส); bigram/Dice similarity is weak at that length (one
edit breaks most bigrams), and the namespace is small/dense enough that
near-misses are often distinct people (e.g. "เกีย" vs "เกียร์" are two
different players across the example messages). Auto-linking on a fuzzy
score risks a wrong silent merge — extends the parser's "never silently
guess" principle rather than inventing new tolerance rules.

1. Normalize: strip trailing `(...)` note (e.g.
   `พี่แวน(พี่ที่ทำงานไกด์)` → `พี่แวน`), trim, Unicode NFC.
2. Exact match (post-normalize) vs `Player.name` + `aliases[]` →
   auto-link (still shown in review screen, never hidden).
3. No exact match → normalized Levenshtein similarity
   (`1 - distance/maxLen`) vs all known names+aliases for the group.
   Score ≥ 0.7 → surface as "ใช่ [X] ไหม?" suggestion, host taps
   confirm/reject. Below 0.7 → flag "new player?".
4. Host confirms a fuzzy/new mapping → pasted text saved as new
   `Player.alias`.
5. Implement inline in TS (~15 lines, no npm dep) — matches
   `parser.ts`'s no-dependency style.

### 6.3 Pairing/rotation engine — **not designed**

Input: confirmed roster + court count + partner-history from prior
`Pairing` records for the group. Output: this round's court
assignments, minimizing repeat partners and balancing who sits out.

**Open decision:** repeat-*partner* avoidance is in v1 scope; whether
repeat-*opponent* balancing (who you've played against, not just with)
is in or out for v1 is not yet decided — call it explicitly before
building, don't let it default silently either way.

### 6.4 Cost split + PromptPay QR — **not designed**

Court + shuttlecock fees entered by host → split per session player →
EMV QR spec generation using `Group.hostPromptPayId`.

## 7. Progress checklist

### Design / decisions
- [x] v1 plan written (scope, tech stack, schema, build order)
- [x] Plan reviewed for gaps (8 findings folded in)
- [x] Fuzzy-match algorithm decided
- [ ] Opponent-balancing scope decision for pairing engine (in/out for v1)
- [ ] Mid-session edit flow designed (reshuffle / late-add / no-show removal)

### Build order
- [x] 1. LINE roster-message parser (`parser.ts`, verified vs 3 real messages)
- [x] 2. Fuzzy-match layer (parsed names → `Player` + `aliases[]`, `fuzzy-match.ts`)
- [ ] 3. Pairing/rotation engine (repeat-partner avoidance + sit-out balancing)
- [ ] 4. Cost split + PromptPay QR generation
- [ ] 5. Angular screens: paste → confirm → shuffle → share → score → split

### Infra
- [x] Git repo initialized, `.gitignore` added
- [ ] NestJS backend scaffolded
- [ ] Angular frontend scaffolded
- [ ] DB schema created (Group, Player, Session, Round, Pairing, Waitlist)
