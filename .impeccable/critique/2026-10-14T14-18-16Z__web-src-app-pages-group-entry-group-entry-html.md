---
target: new forgotten-session closure flow
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/iamgide/Desktop/project/jubBad/web/src/app/pages/group-entry/group-entry.html"
target_fingerprint: "sha256:a60bfdb97375c07ea3efb7fc430697dea59ede8462d774be9ba0212cd6dfe5e5"
target_path: /Users/iamgide/Desktop/project/jubBad/web/src/app/pages/group-entry/group-entry.html
timestamp: 2026-10-14T14-18-16Z
slug: web-src-app-pages-group-entry-group-entry-html
closed: true
---
# Forgotten Session Closure UX Critique

**Method:** dual-agent (A: `/root/ux_design_assessment` · B: `/root/ux_evidence_assessment`). Both assessments were independent. **Evidence:** source review and static detector; no browser provider was available.

## Verdict

**Yes, this needs focused UX/UI improvements.** The flow fits the courtside host's job and the existing Daylight Court identity. The highest priority is preserving duration warnings on small phones, followed by making closure safer and its progress clearer. A visual redesign is unnecessary.

## Design Health

| Heuristic | Score / 4 | Main finding |
|---|---:|---|
| System status | 2 | Preview/closure progress and success are silent |
| Real-world language | 3 | Familiar terms; dense consequences |
| User control | 3 | Resume and cancel available |
| Consistency | 2 | Irreversible confirmation uses ordinary green |
| Error prevention | 3 | Snapshot checks; selected session identity missing |
| Recognition over recall | 2 | Confirmation requires remembering the selection |
| Efficiency | 3 | Direct resume and in-place recovery |
| Minimalist design | 3 | Consequences and counts repeat each other |
| Error recovery | 3 | Retry works; preview error names the wrong operation |
| Contextual help | 3 | Helpful warnings; average provenance needs clarity |
| **Total** | **27/40** | **Acceptable; focused improvements needed** |

## What Works

- **Useful choices:** resume an existing session or explicitly close it before creating another.
- **Safe consent:** real match counts, cancellation, and renewed review after stale data.
- **Honest records:** estimated/unknown duration provenance, measured-only averages, and preserved roster drafts.

## Priority Issues

1. **[P1] Duration warnings disappear on small phones.** `web/src/app/pages/session-summary/session-summary.css:262` hides every `.stat-games` span in the seventh column at `max-width: 22.5rem`. New estimated/partial labels use this class, so the visible total loses its reliability qualifications. **Fix:** hide only the optional average; keep estimated and incomplete-time labels visible and wrapping. **Suggested command:** `/impeccable harden`.
2. **[P1] The confirmation omits the selected session.** `web/src/app/pages/group-entry/group-entry.html:43` has a generic title while the list can contain several sessions. On a phone the selected row can scroll out of view. **Fix:** repeat the selected date and venue, with session code as fallback. Rename the first button to **Review closure** because it opens a preview. **Suggested command:** `/impeccable clarify`.
3. **[P1] Irreversible closure looks routine and requires too much reading.** `web/src/app/pages/group-entry/group-entry.html:44` combines four consequences in one paragraph, followed by repetitive counts; `:57` uses an ordinary green action despite the established danger style. **Fix:** show count-and-outcome rows, such as **Record 1 active game without a result**, omit irrelevant zero-count rows, place billing/estimate notes underneath, and use the existing danger button. **Suggested command:** `/impeccable clarify`.
4. **[P2] Waiting states need explicit feedback.** `web/src/app/pages/group-entry/group-entry.ts:268` disables controls while fetching a preview; the close button keeps the same label during the write. The preview error says closure failed when closure was never attempted. **Fix:** distinct **Loading session details…** and **Closing session…** states, operation-specific errors, and nearby retry. **Suggested command:** `/impeccable harden`.
5. **[P2] Successful closure can focus an unwanted action.** `web/src/app/pages/group-entry/group-entry.ts:304` focuses the textarea on touch devices, opening the keyboard; `:305` can focus **Clear list** after restoring roster review. There is no success announcement. **Fix:** announce the session was closed and focus a neutral next-step heading or the intended continuation control. Preserve the mobile keyboard policy. **Suggested command:** `/impeccable harden`.

## Cognitive Load and Personas

**Cognitive load: moderate**, with three checklist failures: chunking, carrying session identity in memory, and competing decisions while confirmation remains beside the session list. **Emotional journey:** the opening offers reassuring choices, the dense irreversible confirmation creates uncertainty, and the silent ending provides insufficient reassurance.

- **Distracted mobile host:** reliability labels disappear at small widths; the keyboard can cover the clipboard path after recovery.
- **First-time organizer:** needs each count tied directly to its outcome and the selected session repeated at confirmation.
- **Keyboard/screen-reader user:** needs announced preview/progress/success states and focus on the next useful action rather than list clearing.

## Minor Observations

- **Average wording:** label the average as using recorded games so it does not appear inconsistent with a total that includes estimates.
- **Layout verification:** mixed-duration labels inherit `white-space: nowrap`; inspect Thai and English at phone/tablet widths when a browser becomes available. Overflow is a risk, not a visually confirmed finding.
- **Button consistency:** the resume anchor has a 44px target but does not inherit `button.ghost` styling.

## Deterministic Evidence

**Detector:** exit 0, findings `[]`, zero rule violations and zero false positives. The scan did not flag the source-confirmed responsive hiding rule. **Browser inspection/overlays:** unavailable because both browser inventories were empty; no browser or detector server was started.

## Follow-up Choices

- **Priority:** trustworthy mobile recap labels; safer closure confirmation; loading/completion feedback.
- **Scope:** all five issues; the three highest-priority issues; review only.
