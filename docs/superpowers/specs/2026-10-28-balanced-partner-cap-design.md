# สูสี partner cap: a pair partners at most twice a night — design

Status: **draft for owner review (2026-10-28), nothing built; build order is an open question (Decision 3).** The evidence comes from a prototype on
`proto/balance-tolerance-band` (commit 871f178) and the simulations recorded as G9, G10 and G12 in
`docs/2026-09-25-engine-evidence-gaps.md`. Items marked **(my call)** were decided by the writer, not the owner.

## Intent and why

สูสี (balanced mode) picks the split with the smallest rating gap, and a repeat partnership costs it only 10
points against 2 points per rating point of gap (`docs/overview.md`, Pairing). With players a few hundred points
apart the balance term wins nearly every time, so the same pair partners again and again. In the simulation
(evenly spread ratings, 20 matches, which is a normal night) the most repeated pair partners **3.0–4.9 times** in
สูสี for 9–18 players, against 1.5–2.3 in สลับคู่, for teams that are far more even (average gap about 65 points
against about 190, for ratings spread over 900–1600). No real host has run สูสี yet, so this is a prediction, but it is the complaint the owner
expects ("I always partner the same person").

The owner's rule: one or two repeats a night is fine, more is not. This design turns that rule into the objective.

## Goals

1. In สูสี, a pair that has already partnered **twice tonight** is not partnered a third time unless every
   alternative would also break the cap.
2. Keep as much of สูสี's fairness as possible: the simulation shows the average team gap rising from about 65 to
   about 76–98 points, not to สลับคู่'s 190.
3. No schema change, no migration, no UI, no API change. สลับคู่, ระดับ and เลือกเอง behave exactly as today.
4. A test night with the วันพฤหัส group (10 players, 2 courts) that can confirm or refute the simulation.

## Non-goals

- Same-opponent repeats. At these roster sizes they follow from the head count (10 players over 20 matches is 80
  opponent pairings across 45 pairs), so no pairing rule can hold them to 1–2.
- The fixed-quartet rotation at 8, 12 and 16 players. That comes from who is selected to play, not the split;
  G12 records the workaround (propose only once every court is idle).
- Rosters of 5–8 players. A cap of 2 over 5 players holds for only 10 matches (10 pairs × 2), so repeats there are
  forced whatever the rule says.
- A per-group or per-session setting for the cap. See "Decisions".

## Design

### The rule

`CAP = 2` partnerships tonight. A pair with a session partnership count of 2 or more is **capped**. An arrangement
that would partner a capped pair again gets a `capBreaks` count of 1 for each such team.

### Where it sits in the comparison **(my call)**

`capBreaks` becomes a score component compared **before** the weighted balance/partner/opponent score, in the same
position as the other priorities that must not be traded for a price:

```
groupRepeat -> targetMiss -> bandBreaks -> capBreaks -> weighted (2 x gap + 10 x partner + 1 x opponent)
```

This follows the lesson already written in `compareArrangements`: "a plain additive weight, however large, is
eventually swamped". The prototype added 100 repeat charges (1,000 points) to the partner term instead, which
works for gaps below 500 but is not strictly dominant: two teams 600 apart score 1,200. A separate component
cannot be swamped and is easy to explain.

It is **soft in effect** the same way the band is: when every arrangement breaks the cap (a small roster, or a very
long night), the engine takes the fewest breaks and then applies the normal score. It never refuses to propose.

### Scope

- **สูสี only.** The component is computed only when ratings are supplied, as `balance` is, so variety (already
  lexicographic on partner repeats), level and the rest are byte-identical to today.
- **Doubles only.** A singles team has no partner.
- It changes how the chosen players are grouped and split. It does not change **who plays**: sit-out selection
  (games played, then wait) is untouched.

### Counting **(my call)**

- The count is **this session's confirmed matches**, never all-time. `MatchHistory` gains an optional
  `sessionPartnerCounts`; `deriveHistory` fills it from `thisSessionPairings` (it already has them). The cap reads
  `sessionPartnerCounts ?? partnerCounts`.
- Why a separate map: when a group switches on all-time history (`Session.crossSessionHistory`), `partnerCounts` is
  all-time, and a cap of 2 on that would block most pairs for good. For every group today (วันพฤหัส included:
  `crossSessionHistory` is off) the two maps are identical.
- The count is the raw tally, not the floor-adjusted one used by the partner term. The floor keeps scores stable as
  history grows; the cap is an absolute "times tonight".
- Counts come from confirmed matches only, so free reshuffling, resting a player and undo compose as they do for
  every other history input (`docs/overview.md`: history updates only on confirm).

### Interactions

- Pair rules (hard) and the reshuffle's shown-split exclusion are applied first; the cap only chooses among what
  remains.
- `groupRepeat` (do not reform the quartet that just played) is compared first, as today.
- Both search paths (exact up to 8 players on court, local search above) score through
  `arrangementScoreComponents`, so neither needs its own change. `engines/pairing-quality.test.ts` gains a balanced
  case checked against exhaustive enumeration.
- Bad input fails loudly as everywhere else: `validateRoundInput` rejects a negative or non-finite
  `sessionPartnerCounts` entry.

### Code touched

| File | Change |
|---|---|
| `engines/pairing.ts` | `capBreaks` component; compared in `compareArrangements` and `compareComponents`; `negate` and `totalComponents` carry it; `MatchHistory.sessionPartnerCounts`; validation |
| `server/src/sessions/derive-history.ts` | fill `sessionPartnerCounts` from this session's pairings |
| `docs/overview.md` | the balanced paragraph in "Three pairing modes" states the cap and why it is a priority rather than a weight |
| tests | engine unit tests (cap holds when avoidable, yields when not, never in variety or level), quality test, `derive-history` spec |

No change to `sessions.service.ts` call sites: both already pass `history` and `ratings`.

## What to expect (simulation, evenly spread ratings)

For 10–11, 13–15 and 17–18 players at 20 matches (9 players gets 2.5 and a gap of about 120):

| | today | with the cap | สลับคู่ |
|---|---|---|---|
| Most repeated partner pair | 3.0–4.2 times | 2.0–2.1 | 1.5–2.3 |
| Pairs that partner 3+ times | 1.6–4.1 | 0–0.1 | about 0 |
| Average team gap (points) | 60–67 | 76–98 | 180–195 |

Known limits: 5–8 players repeat regardless; the cap erodes late in a long night (10 players: 2.9 at 30 matches);
a roster of exactly 12 on 2 courts, 16 on 3 or 8 on 2 gains little unless the host waits for every court to be idle
(G12); in the 12-player case the cap raises the gap to about 166 for no variety gain.

## Test night: วันพฤหัส, สูสี, 10 players

Why this group: 18 known players and 7 nights of history (142 decisive doubles matches), so ratings have already
separated (about 1094 to 1425 among the regulars), none of the players has a level tagged, and `crossSessionHistory` is off. Its real
sessions are 2 courts, so 10 players means 2 sit out a round, which is the roster the 10-player simulation covers.

**Host does:** start the session in **สูสี** instead of สลับคู่ and run as normal. Proposing the moment one court
frees is fine at 10 players (the pool is 8 players, so there is room to mix). Nothing else changes.

**Expected (simulated with this group's real ratings, 300 runs, 10 players on 2 courts).** The 10 most
active players' current ratings are 1094 to 1425, much narrower than the 900–1600 used elsewhere in this doc,
because their Elo has had only 7 nights at K = 16. Team gaps are therefore small in absolute terms:

| After | | Most repeated pair | Pairs partnering 3+ times | Average team gap | Favourite wins (by rating) |
|---|---|---|---|---|---|
| 20 matches | สูสี today | 3.9 | 3.4 | 34 | about 55% |
| | **สูสี + cap 2** | **2.0** | **0.1** | **49** | about 57% |
| | สลับคู่ | 2.0 | 0.0 | 85 | about 62% |
| 30 matches | สูสี today | 5.3 | 7.7 | 34 | about 55% |
| | **สูสี + cap 2** | **2.8** | **1.3** | **61** | about 57% |
| | สลับคู่ | 2.5 | 0.7 | 85 | about 62% |

- A real night is about 24 matches, so read between the two blocks.
- The 85-point variety figure matches the real record: this group's last three variety nights averaged a rating
  gap of 77 on the same Elo replay.
- Cap 1 gets closer to สลับคู่ on repeats (2.2 at 20 matches) at a gap of 69; cap 3 does little (3.0 worst pair,
  3.3 pairs at 3+). Cap 2 is the middle of the dial.
- **Without the cap, สูสี already repeats for this group** (worst pair 3.9 at 20 matches), so a night on `main`
  would show the problem even without the change. That is useful if the cap ships after the night rather than
  before: run the first night on `main` as the baseline.

**What I do afterwards:** take an online backup, then run the evidence scripts (`engines/evidence/`, moving
`small-roster-sim.mts` onto `main` with the build) against that night: per-pair partner counts, worst pair, the team
rating gap of every match at the time it was played, and how often the rating favourite won.

**Pass:**
1. No pair partners 3+ times in the first 20 matches.
2. Average team gap no more than about 65 (the simulation says about 50 for a 24-match night; this group's variety nights ran about 80).
3. No player says "I always partner the same person" (the real test; the owner asks the group).

**If it fails:** a pair at 3 or more means either the cap was saturated (check how many unused pairs remained: the
cap holds only while pairs × 2 exceeds partnerships) or a bug, and the count data tells which. A host complaint
about uneven teams means the cap is too strong for this group, and the options are cap 3 or a gap ceiling (see
below).

## Alternatives considered

- **Additive large weight (the prototype).** Works for typical gaps, can be swamped for extreme ones, and is harder
  to explain. Rejected.
- **Tolerance band** (a court's gap only counts above N points). Measured as a dial, not a fix: variety gained
  trades against fairness almost one for one, and a tolerance of 600 reproduces สลับคู่ exactly. At 10 players,
  with a gap of 131 it reaches only 2.4 repeats where the cap reaches 2.1 at a gap of 98. Rejected.
- **Confidence-scaled balance weight** (the G9 candidate). Aims at unreliable early ratings, but the simulation
  with perfectly known skill still repeats partners 12–25% (G9), so rating accuracy is not what drives the
  repeats. Not tested; not needed.
- **Alternate rounds of สลับคู่ and สูสี.** Averages the two with no guarantee for either. Not built.

## Decisions

1. **Hard priority, no gap ceiling (my call).** Once a pair is capped, avoiding a third partnership beats any
   balance cost. The simulation's average gap stays near 76–98, but a single round in a small group could be quite
   uneven (an extreme case: the only cap-free split pairs the two strongest players against the two weakest).
   **Open question for the owner:** accept that, or add a ceiling (the cap yields when the only cap-free
   arrangement has a gap above, say, 300 points)? I recommend accepting it for the test night and adding a ceiling
   only if the night shows the problem, because a ceiling adds a second number to explain and tune.
2. **A constant, not a setting (my call).** `CAP = 2` in `engines/pairing.ts`. No group has used สูสี, so there is
   nobody to protect with an opt-in; a setting would add a migration and a settings row to guard against a mode no
   one uses. If the night shows a different number is right (1 or 3), changing it is one line.
3. **Order of the test night (open question for the owner).** Two ways to run the วันพฤหัส night:
   - **A. Baseline first.** Run the night on the current `main` (nothing to build or deploy). The prediction
     for this group's ratings is a worst pair of about 3.9 at 20 matches, and the night turns that into a real
     number, along with the real team gap. Then build the cap only if hosts and players actually complain. This
     fits the roadmap rule that an item needs real-session evidence, and costs one week.
   - **B. Cap first.** Build and deploy the cap, then run the night. Faster, but the night measures the cap alone
     and the baseline stays a simulation. The change affects only สูสี sessions, and none exist, so deploying
     ahead of the night is low risk (it needs the usual backup first, though no migration).
   I recommend **A**: the cap is cheap to build later, and the first real สูสี night is worth more as an untouched
   baseline than as the first test of an unproven fix.

## Open risks

- The evidence is simulated: one fitted skill model, static ratings, whole rounds. The test night is the first real
  data point, from 10 players in one group.
- Fairness cost is real: across rosters the gap grows 13% (18 players) to 63% (10 players, wide ratings); for this
  group's real ratings it goes from 34 to 49 points (the favourite is expected to win about 57% of games instead
  of 55%). A host who chose สูสี for even teams will see slightly less even ones in exchange for variety.
- Players who arrive late or leave early change the number of unused pairs mid-night; the cap adapts per round
  because it is recomputed from confirmed matches each time.
