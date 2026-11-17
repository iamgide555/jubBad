---
target: sign-up flow (signup, line-signup, line-link, privacy, trial offer)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/iamgide/Desktop/project/jubBad/web/src/app/pages/signup"
timestamp: 2026-11-17T10-29-25Z
slug: web-src-app-pages-signup
---
Method: dual-agent (A: design-review agent, B: detector and browser agent)

# Critique: sign-up flow (/signup, /privacy, /login link, LINE sign-up and link pages, trial offer)

Verdict: the form mechanics are sound; the problem is identity and hierarchy. Sign-up is the plainest screen in the app (login has the 3D sprout hero), it never says what JubBad is, and the best offer (LINE, 30-day trial) is the weakest link on the page. Detector: 0 findings.

## Design health score: 24/40 (Acceptable)
1 status 3; 2 real world 2; 3 control 3; 4 consistency 2; 5 error prevention 3; 6 recognition 3; 7 flexibility 2; 8 minimalist 2; 9 error recovery 3; 10 help 1.

## Priority issues
- [P1] No identity, no pitch: grey h1, one small lede, two fields. Fix: short sprout hero (~96px), promise headline, three one-line benefits, form still above the fold (submit is at y=443 of 844 today). /impeccable bolder
- [P1] Two doors unordered; LINE (30-day trial) is a grey link with the same weight as "already have an account?". Fix: green full-width "สมัครผ่าน LINE" first with the trial as sub-label, divider "หรือใช้อีเมล", then the form; login link small in the footer. /impeccable layout
- [P2] Consent and recovery copy clutter the form; the "link LINE later" note frames sign-up as a risk. Fix: one small consent line; move the recovery note to the post-sign-up offer. /impeccable distill
- [P2] No arrival moment; trial offer reads as a nag. Fix: one-line welcome on /groups/new; offer as a card with outcome button and one line on what all features includes. /impeccable delight
- [P3] LINE pages ask for a new password in LINE's browser and have 9 thin states. Fix: one status block; primary CTA first on done. /impeccable clarify

## Measured defects (B)
Same <title> on every route; no <main>; inline links under 44px (409 error link 19px, EN privacy link 19px, privacy contact 20px, TH consent 43px); disabled submit 2.70:1 dark / 4.14:1 light; forgot-mode cancel 42.7px wide and submit at the screen edge at 320x700; 5-char password still enables submit; consent link wraps mid-phrase in Thai; labels ~36px above inputs.
Passes: no overflow at 320/390/1280; inputs 44px tall at 16px; Thai glyphs render; trap out of Tab order; enabled contrast 6.5-9.4.

## Personas
Jordan: nothing explains JubBad or the trial. Casey: four grey links under the button, LINE option easy to scroll past. Sam: no <main>, identical titles, short links. Club organiser from a LINE chat: bare form, no reason to continue; the rich menu image does the selling, the page doesn't.

## Questions
Why is the web form the default door when LINE could be two taps? What would the page say in one sentence and one court-board screenshot? Is "no ceremony" a reason or an excuse?
