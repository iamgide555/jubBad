---
target: plan gating free-host surfaces (feat/plan-gating)
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/iamgide/Desktop/project/jubBad/web/src/app/shared/plan-lock/plan-lock.html"
timestamp: 2026-10-26T07-03-06Z
slug: web-src-app-shared-plan-lock-plan-lock-html
closed: true
---
# Plan gating critique (feat/plan-gating, free-host surfaces) — 2026-10-26

DEGRADED: single-context (session policy limits sub-agent spawning; design review finished before detector output was read)

Tested in browser on an isolated scratch DB as free, host (renews 28/10), lapsed host (expired 10/10) and admin, at 390px phone width.

## Heuristics (22/40, Acceptable)
1 Visibility 2 — a lapsed host is downgraded silently; inactive features look switched on; group limit shown only after typing a name
2 Match 2 — "ติดต่อผู้ดูแล" while the host's own role is labelled "ผู้ดูแลก๊วน"
3 Control 3 — inline one-way confirm; turning things off is never blocked
4 Consistency 2 — players page links into the greyed levels page; a disabled select looks enabled
5 Error prevention 3 — one-way confirm and disabled controls; group cap found out late
6 Recognition 2 — nowhere shows what Host unlocks
7 Flexibility 2 — admin renews by typing a date every month; two save buttons
8 Aesthetic 2 — the lock line repeats 2–3 times a screen; mode toggle stacks 4 lines; Thai breaks inside แพ็กเกจ
9 Recovery 3 — clear refusal copy; GROUP_LIMIT appears in red like a mistake
10 Help 1 — no path to upgrade, no list of what Host includes

## Priority issues
- P1 Upgrade path is a dead end ("contact the admin": who, and how?)
- P1 Silent lapse, and no warning before expiry
- P1 Features that are on but inactive look active (green check; "เปิด 1 จาก 2" badge)
- P2 Lock-note noise and layout under the mode toggle and in the bill; Thai line breaks
- P2 Group cap revealed only after typing a name; the confirm says "this mode" without naming it

## Minor
- 30-day archive note shows even when nothing is hidden
- Players page "ตั้งชื่อระดับของก๊วน →" skips past the greyed levels row
- Levels editing stays free but changes nothing in free modes; the levels page opens with Elo copy
- Disabled rule select and ไม่มา chips (2.7:1) look the same as enabled ones
- Profile locked copy suggests the host has a switch to turn on
- Admin: "ฟรี ถึง <date>"; lapsed row wording order; two saves; no +1 month; over-cap host not flagged; reassign skips the cap

## Gaps / questions
- Over-cap after a downgrade: every group stays usable
- Existing PlayerRules keep steering pairing after a lapse; an issued /d/ token keeps working
