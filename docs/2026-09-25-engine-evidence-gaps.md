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
  - 2026-10-15 check: no usable evidence. Only 12 of 279 confirmed matches were สูสี, all one night in a group with no history and 14/15 players untagged, so ratings spanned ≤24 points (about 3% win probability). A B+BG vs P+P split could not occur. Revisit after a สูสี night with tagged levels or 30+ matches of history.
- [x] G5. — done 2026-10-01 by making partner/opponent history per-session (see `docs/overview.md`, Pairing). Original note: history counts were all-time raw totals; frequent attenders accumulate partner history from attendance alone, and floor normalisation is a no-op for ranking. Consider per-attendance normalisation or a window; measure in `engines/variety-sim.ts` first.
- [ ] G6. Level mode has no cap on the games-played gap an in-band player can gain over an out-of-band one. Add only if a session shows a gap of 2+ *among players present throughout*.
  - 2026-10-15 check: not triggered. The one real ระดับ night (20 players, 3 courts, 17 matches) had an overall gap of 2, but only from 3 walk-ins who first played in match 9–10; players present throughout were within 1 (3–4 games). Late arrival, not the band.
- [ ] G7. In mature groups partner totals rarely tie, so the opponent term almost never decides in variety mode. Measure first; speculative.
  - 2026-10-15: not measurable yet. History is now per-session by default (G5), so the "mature group" premise needs re-reading; only 2 ระดับ sessions exist.
- [ ] G8. A proposal plans all idle courts and commits one; the committed court may not hold the most-deserving players if the other idle court stays empty. Low impact, no action planned.
