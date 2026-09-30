# Engine evidence questions (2026-09-25)

G4–G8 came from a code audit, not observed session failures. They are
hypotheses to investigate with real-session evidence, not scheduled fixes.
G1–G3 were resolved and remain recorded in the
[archived feature review](archive/2026-09-21-feature-review-and-roadmap.md).

Record anonymized session context and the observed pairing/queue outcome
before proposing a rule change. Use measurements or simulation where noted,
but do not commit identifiable player or session data.

## Open questions

- [ ] G4. Balanced mode compares team *averages*, so B+BG vs P+P scores as balanced. Consider a within-team spread term. Needs session evidence.
- [ ] G5. History counts are all-time raw totals; frequent attenders accumulate partner history from attendance alone, and floor normalisation is a no-op for ranking. Consider per-attendance normalisation or a window; measure in `engines/variety-sim.ts` first.
- [ ] G6. Level mode has no cap on the games-played gap an in-band player can gain over an out-of-band one. Add only if a session shows a gap of 2+.
- [ ] G7. In mature groups partner totals rarely tie, so the opponent term almost never decides in variety mode. Measure first; speculative.
- [ ] G8. A proposal plans all idle courts and commits one; the committed court may not hold the most-deserving players if the other idle court stays empty. Low impact, no action planned.
