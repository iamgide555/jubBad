---
target: plan gating free-host surfaces (feat/plan-gating-ipad-fixes), run 2
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/iamgide/Desktop/project/jubBad/web/src/app/shared/plan-lock/plan-lock.html"
target_fingerprint: "sha256:ea49310a0f836c77b6d424a10f3bfa9b3f9fdcfe503933f70ab5ea91f16e9acc"
target_path: /Users/iamgide/Desktop/project/jubBad/web/src/app/shared/plan-lock/plan-lock.html
timestamp: 2026-10-26T10-26-14Z
slug: web-src-app-shared-plan-lock-plan-lock-html
---
# Plan gating critique, run 2 (branch feat/plan-gating-ipad-fixes) — 2026-10-26

Method: dual-agent (A: design review, isolated, opus · B: detector + browser overlay, isolated, sonnet). B's report reached the parent before A's; A never saw B's output.

## Heuristics: 23/40 (Acceptable). Baseline run 1: 22/40.
1 Visibility 2 — disabled fee inputs (bill) and level name/Elo inputs render at full opacity so they look editable; inactive switch looks like a disabled one
2 Match real world 3 — natural Thai; but plan dates are 28/10/2026 beside "จันทร์ 5 ต.ค."; "(ก๊วนที่เล่นล่าสุด)" is system logic
3 Control 2 — a paused group is a dead end; turning off an inactive switch has no confirm while leaving สูสี does
4 Consistency 2 — three lock idioms; dialog shows the browser-default blue focus ring
5 Error prevention 3 — one-way confirm, fail-open, server enforcement
6 Recognition 3 — dashboard locks sit beside controls; on levels/bill the reason comes after the dead controls
7 Flexibility 2 — +1 เดือน good; locked segments cannot be tapped through to the sheet
8 Aesthetic 2 — levels: ~1,800px of disabled form; bill: ~40 chips; mode lock leaves ~48px dead space in the toggle
9 Recovery 2 — paused start and create-at-cap offer only a sales sheet
10 Help 2 — sheet has no price, no current plan/date, no Club, no "what happens after LINE"

## Detector (B)
CLI: 22 changed templates, exit 0, 0 findings.
Overlay: 0 on landing, group home (closed/open), upgrade sheet, paused group. Dashboard 5-6, bill 24, admin 1-3.
Only plan-gating finding: 21 disabled ไม่มา chips at 2.7:1 on the bill (closed details; disabled).
Everything else pre-existing or tooling artefacts (overlay label, extension banner, body dark-glow).

## Priority issues
P1 Locked inputs look live (bill host/walk-in fee; levels name/Elo fields): global dim rule only covers select:disabled
P1 Paused group and create-at-cap are dead ends (no active group named, no ways out stated, create page promises a form)
P1 Upgrade sheet does not know where it was opened from (renew shows the same pitch; no date; no Club at cap; CTA leaves the session)
P2 Dashboard mode lock breaks the toggle (dead pill space, 40px segments, no aria-pressed, 0.7 opacity disabled segment) — NOT verified by the parent
P2 Walls of dead controls (levels, bill); one-way confirm fills the losing choice green

## Persona red flags
Courtside iPad host: greyed ตามระดับ does nothing; ดูแพ็กเกจ is small text; confirm sits ~110px under the tap.
Sam: dialog takes default blue focus ring, no aria-pressed, faint พักไว้ and ก๊วน 2/1 chips.
Jordan: "ก๊วน 2/1" reads like a bug; plan "โฮสต์" vs role "ผู้ดูแลก๊วน".
Riley: dashboard shows สูสี active while rules say off; paused group with a live session; admin edit row reflows the table.

## Minor
"หมด 28/10/2026" reads as already ended; leaked shadow behind ต่ออายุ/ดูแพ็กเกจ; admin role column breaks mid-word at 1180; levels row stays a link on a custom ladder while the page is fully disabled; inactive-switch hint reads as description.

## Questions
Should a free host see any plan UI on the live dashboard? Is "โฮสต์" the right plan name when every user is a host? What if upgrading were a pre-filled LINE message from a sheet that keeps the session in view?
