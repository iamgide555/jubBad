# Pairing modes walkthrough: 11 players on 2 courts, 15 players on 3 courts (2026-10-28)

A round-by-round run of the real pairing engine (`generateRound`) in the three non-custom modes, to see how
each one picks who plays and how it partners them over a 14-round night. A follow-up to the 10-player,
2-court example discussed the same day. Illustration, not a statistic: one seeded run per roster.

## Setup

- Engine: `engines/pairing.ts` `generateRound`, called with the inputs the server builds (per-session
  partner/opponent counts, games played, waiting-since, the groups that just played). Custom mode is excluded.
- Modes: **สลับคู่** (variety: no ratings, repeat partners then repeat opponents), **สูสี** (balanced: Elo
  rating gap weighted 2 per point against repeat partners 10 and repeat opponents 1), **ระดับ** (level: queues
  by wait alone, ±1 level band, no ratings).
- Players are lettered weakest to strongest, with ratings spread evenly from 900 to 1600. Levels for ระดับ are
  assigned by rank across the eight ladder rungs (BG, N, S, P-, P, P+, C, B). Ratings are static: they never
  update during the run.
- 14 rounds, both rosters, all courts finish and re-propose together each round, the same random seed (7) in
  all three modes, so only the objective differs.
- Table cells read `AB v CD (gap)`: team 1 against team 2, then the difference between the two teams' average
  ratings (0 is an even match). A trailing `*` marks a team whose two players had already partnered earlier in
  the night (`**` means both teams repeat).

## Summary across both rosters

| | 11 players, 2 courts | | | 15 players, 3 courts | | |
|---|---|---|---|---|---|---|
| | สลับคู่ | สูสี | ระดับ | สลับคู่ | สูสี | ระดับ |
| Average team gap | 186 | **6** | 190 | 195 | **5** | 95 |
| First round with a repeat partner | 12 | 6 | 11 | none | 13 | 8 |
| Courts with a repeat partner | 3 of 28 | 13 of 28 | 4 of 28 | 0 of 42 | 4 of 42 | 15 of 42 |
| Most repeated partner pair | 2 | 3 | 2 | 1 | 2 | 3 |
| Partner pairs that happened | 53 of 55 | 37 of 55 | 50 of 55 | 84 of 105 | 80 of 105 | 56 of 105 |
| Most repeated opponent pair | 3 | 6 | 4 | 3 | 6 | 8 |
| Games per player (min–max) | 10–11 | 10–11 | 8–12 | 11–12 | 11–12 | 8–13 |

## Findings

- **A bigger pool relative to the courts makes สูสี far less repetitive.** With 15 players on 3 courts (3
  sitting out) สูสี averaged a team gap of 5 and repeated a partner on only 4 of 42 courts (first in round
  13, no pair more than twice), against 13 of 28 courts for 11 players on 2 courts (first in round 6, two pairs
  three times). For comparison, the 10-player, 2-court run had its first repeat in round 7 and 12 of 28 courts.
  This agrees with the earlier simulation: the more players beyond the seats, the more fresh pairs there are.
- **สลับคู่ does not repeat for 11 rounds on 11 players and not at all on 15.** With 3 courts and 15
  players, 14 rounds of 6 partnerships produced 84 different partner pairs. The price is evenness: its average
  team gap is 186–195 against 5–6 for สูสี.
- **สูสี repeats opponents more than สลับคู่.** Its most repeated opponent pair meets 6 times in both rosters,
  against 3 for สลับคู่ (ระดับ reaches 4 and 8). Balancing the teams keeps reusing the same pairs of strengths
  against each other.
- **ระดับ repeats same-level partners.** In the 15-player run the most repeated pairs are same-level partners
  (A with B, G with H, C with D, 3 times each) and only 56 of 105 partner pairs happened, because the band
  keeps each player inside a few levels. Its team gap depends on how the levels line up (190 for 11 players,
  95 for 15), not on rating.
- **ระดับ playing time is uneven, and in the 15-player run the top of the ladder sat most.** The range is
  8–12 games (11 players) and 8–13 (15 players), while the other two modes stay within 1 game of each other. In the 15-player run the
  strongest player (O) played 8 games and K 9, and L, M and N 10, against 13 for A, C, D and H. This is the known G6 gap in
  `docs/2026-09-25-engine-evidence-gaps.md` (no cap on the games gap an in-band player can gain). Here every
  court finishes at the same instant, so waits tie exactly and the band decides; real waits differ by seconds, so
  the gap may be smaller in practice.

## Follow-up: rosters where 0 or 4 players sit out

The earlier simulation (G9/G12 in `docs/2026-09-25-engine-evidence-gaps.md`) found that 8 players on 2 courts,
12 on 2 and 16 on 3 rotate through a few fixed quartets when courts finish one at a time, because only the
finishing court's four players and the four who sat can be re-mixed. The same method as above, with every court
re-planned together each round (what `propose` does when all courts are idle), 14 rounds, evenly spread ratings,
seed 7:

| | สลับคู่ | สูสี | ระดับ |
|---|---|---|---|
| **12 players, 2 courts** | | | |
| Average team gap | 198 | 2 | 170 |
| First round with a repeat partner | 14 | 7 | 12 |
| Courts with a repeat partner | 1 of 28 | 10 of 28 | 3 of 28 |
| Most repeated partner pair | 2 | 2 | 2 |
| Partner pairs that happened | 55 of 66 | 45 of 66 | 53 of 66 |
| Most repeated opponent pair | 3 | 5 | 4 |
| **16 players, 3 courts** | | | |
| Average team gap | 175 | 4 | 92 |
| First round with a repeat partner | none | 8 | 5 |
| Courts with a repeat partner | 0 of 42 | 6 of 42 | 11 of 42 |
| Most repeated partner pair | 1 | 2 | 2 |
| Partner pairs that happened | 84 of 120 | 78 of 120 | 64 of 120 |
| Most repeated opponent pair | 2 | 4 | 7 |
| **8 players, 2 courts** | | | |
| Average team gap | 193 | 0 | 193 |
| First round with a repeat partner | 8 | 5 | 8 |
| Courts with a repeat partner | 14 of 28 | 20 of 28 | 14 of 28 |
| Most repeated partner pair | 2 | 4 | 2 |
| Partner pairs that happened | 28 of 28 | 16 of 28 | 28 of 28 |
| Most repeated opponent pair | 5 | 8 | 5 |

- **Waiting until all courts are idle removes the lock-in at 12 and 16 players.** The worst pair partners twice
  or less in every mode, against 9.0 and 6.9 times in สูสี (3.9 and 3.0 in สลับคู่) at 30 matches when courts
  finish one at a time. The cost is that the first court to finish waits for the other.
- **8 players in สูสี is still limited.** Nobody sits out and balance dominates, so only 16 of 28 partner pairs
  happen and one pair repeats 4 times. สลับคู่ and ระดับ meet all 28 pairs, and their repeats are arithmetic (56
  partnerships over 28 pairs).
- One seed per cell, like the rest of this report.

## Caveats

- One seeded run per roster. Repeat counts move with the seed, so read the tables for how the modes behave, not
  for exact figures. The 200-run simulation in `docs/2026-09-25-engine-evidence-gaps.md` (G9) is the statistical
  version.
- All courts finish together each round, which makes waits tie exactly. Production courts rotate independently,
  so a host who proposes the moment one court frees gets the one-court-at-a-time behaviour, not this one (see the
  follow-up above).
- Ratings are fixed and evenly spread. Real groups have clusters, and ratings change as results come in.

## Detail: 11 players, 2 courts (3 sit out each round)

Players, weakest to strongest (rating / level used by ระดับ):

| Player | A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Rating | 900 | 970 | 1040 | 1110 | 1180 | 1250 | 1320 | 1390 | 1460 | 1530 | 1600 |
| Level | BG | BG | N | S | S | P- | P | P+ | P+ | C | B |

**Summary**

| | สลับคู่ (variety) | สูสี (balanced) | ระดับ (level) |
|---|---|---|---|
| Average team gap (rating points) | 186 | 6 | 190 |
| First round with a repeat partner | 12 | 6 | 11 |
| Courts with a repeat partner | 3 of 28 | 13 of 28 | 4 of 28 |
| Most repeated partner pair | 2 times | 3 times | 2 times |
| Most repeated pairs | AI×2, EF×2, BH×2, AB×1 | CJ×3, AH×3, AI×2, FG×2 | BI×2, HJ×2, CI×2, BG×2 |
| Partner pairs that happened | 53 of 55 | 37 of 55 | 50 of 55 |
| Most repeated opponent pair | 3 times | 6 times | 4 times |
| Games per player (min–max) | 10–11 | 10–11 | 8–12 |

**Games played per player after 14 rounds**

| Player | Rating | Level | สลับคู่ (variety) | สูสี (balanced) | ระดับ (level) |
|---|---|---|---|---|---|
| A | 900 | BG | 10 | 10 | 11 |
| B | 970 | BG | 11 | 11 | 12 |
| C | 1040 | N | 10 | 10 | 10 |
| D | 1110 | S | 10 | 10 | 8 |
| E | 1180 | S | 10 | 10 | 10 |
| F | 1250 | P- | 10 | 10 | 10 |
| G | 1320 | P | 10 | 10 | 11 |
| H | 1390 | P+ | 10 | 10 | 12 |
| I | 1460 | P+ | 11 | 11 | 12 |
| J | 1530 | C | 10 | 10 | 8 |
| K | 1600 | B | 10 | 10 | 8 |

**สลับคู่ (variety)**

| Round | Sit out | Court 1 | Court 2 |
|---|---|---|---|
| 1 | D E K | AB v IG (455) | HC v FJ (175) |
| 2 | B F I | GE v CJ (35) | HD v AK (0) |
| 3 | C G J | FK v AI (245) | EH v BD (245) |
| 4 | A F H | DK v BC (350) | GJ v IE (105) |
| 5 | C J K | FI v ED (210) | HA v BG (0) |
| 6 | A E H | JK v GD (350) | BI v CF (70) |
| 7 | B D I | JH v CA (490) | KG v EF (245) |
| 8 | E G J | FA v KC (245) | DI v HB (105) |
| 9 | D H I | BF v JA (105) | GC v KE (210) |
| 10 | C F K | EB v HI (350) | AG v JD (210) |
| 11 | A B G | DF v EC (70) | HK v IJ (0) |
| 12 | C E J | BH v GF (105)* | KI v AD (525) |
| 13 | F G H | DC v IA (105)* | BK v JE (70) |
| 14 | A D K | GH v CI (105) | JB v EF (35)* |

**สูสี (balanced)**

| Round | Sit out | Court 1 | Court 2 |
|---|---|---|---|
| 1 | D E K | AI v BH (0) | GF v CJ (0) |
| 2 | B F I | GC v HA (35) | EJ v DK (0) |
| 3 | C G J | FE v IB (0) | AK v HD (0) |
| 4 | A F H | DG v BJ (35) | KC v IE (0) |
| 5 | C J K | FI v HG (0) | EA v DB (0) |
| 6 | A E H | JC v BK (0)* | GF v DI (0)* |
| 7 | B D I | JH v KF (35) | EC v AG (0) |
| 8 | E G J | FK v HI (0)* | AD v CB (0) |
| 9 | D H I | BF v GA (0)* | KC v JE (35)** |
| 10 | C F K | EI v JD (0)* | AH v BG (0)* |
| 11 | A B G | DE v FC (0) | HK v IJ (0) |
| 12 | C E J | BG v HA (0)** | KD v IF (0)** |
| 13 | F G H | DE v IA (35)** | BK v CJ (0)** |
| 14 | A D K | GJ v HI (0)* | EC v BF (0)** |

**ระดับ (level)**

| Round | Sit out | Court 1 | Court 2 |
|---|---|---|---|
| 1 | D E K | AB v IG (455) | HC v FJ (175) |
| 2 | B F J | GC v EI (140) | HD v AK (0) |
| 3 | C G K | FA v JB (175) | IH v ED (280) |
| 4 | D F J | CK v AG (210) | HE v BI (70) |
| 5 | A C K | GE v HJ (210) | FB v ID (175) |
| 6 | E H J | IF v KG (105) | AC v BD (70) |
| 7 | A D K | IC v FH (70) | JE v BG (210) |
| 8 | B F I | GH v AD (350) | KE v JC (105) |
| 9 | D E J | BC v KI (525) | HA v FG (140) |
| 10 | G I K | DF v EC (70) | AJ v HB (35) |
| 11 | D E J | BK v GH (70)* | IA v FC (35) |
| 12 | C G H | BE v FK (350) | IJ v AD (490)* |
| 13 | D F J | EA v HK (455) | BG v CI (105)** |
| 14 | A C K | GD v EF (0) | JH v BI (245)** |


## Detail: 15 players, 3 courts (3 sit out each round)

Players, weakest to strongest (rating / level used by ระดับ):

| Player | A | B | C | D | E | F | G | H | I | J | K | L | M | N | O |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Rating | 900 | 950 | 1000 | 1050 | 1100 | 1150 | 1200 | 1250 | 1300 | 1350 | 1400 | 1450 | 1500 | 1550 | 1600 |
| Level | BG | BG | N | N | S | S | P- | P- | P | P | P+ | P+ | C | C | B |

**Summary**

| | สลับคู่ (variety) | สูสี (balanced) | ระดับ (level) |
|---|---|---|---|
| Average team gap (rating points) | 195 | 5 | 95 |
| First round with a repeat partner | none | 13 | 8 |
| Courts with a repeat partner | 0 of 42 | 4 of 42 | 15 of 42 |
| Most repeated partner pair | 1 times | 2 times | 3 times |
| Most repeated pairs | CM×1, AF×1, DI×1, HN×1 | AO×2, EM×2, AG×2, BN×2 | AB×3, GH×3, CD×3, GI×2 |
| Partner pairs that happened | 84 of 105 | 80 of 105 | 56 of 105 |
| Most repeated opponent pair | 3 times | 6 times | 8 times |
| Games per player (min–max) | 11–12 | 11–12 | 8–13 |

**Games played per player after 14 rounds**

| Player | Rating | Level | สลับคู่ (variety) | สูสี (balanced) | ระดับ (level) |
|---|---|---|---|---|---|
| A | 900 | BG | 11 | 12 | 13 |
| B | 950 | BG | 12 | 11 | 11 |
| C | 1000 | N | 11 | 11 | 13 |
| D | 1050 | N | 11 | 12 | 13 |
| E | 1100 | S | 11 | 11 | 11 |
| F | 1150 | S | 11 | 11 | 12 |
| G | 1200 | P- | 12 | 12 | 12 |
| H | 1250 | P- | 11 | 11 | 13 |
| I | 1300 | P | 11 | 11 | 12 |
| J | 1350 | P | 11 | 11 | 11 |
| K | 1400 | P+ | 12 | 11 | 9 |
| L | 1450 | P+ | 11 | 11 | 10 |
| M | 1500 | C | 11 | 11 | 10 |
| N | 1550 | C | 11 | 11 | 10 |
| O | 1600 | B | 11 | 11 | 8 |

**สลับคู่ (variety)**

| Round | Sit out | Court 1 | Court 2 | Court 3 |
|---|---|---|---|---|
| 1 | B G J | MC v FA (225) | ID v HN (225) | EO v LK (75) |
| 2 | A C E | IL v BG (300) | KF v DH (125) | ON v JM (150) |
| 3 | F H M | NC v LB (75) | OK v IG (250) | EJ v DA (250) |
| 4 | D I K | AO v NB (0) | CL v HJ (75) | GE v FM (175) |
| 5 | L N O | GC v ED (25) | FI v JA (100) | HK v MB (100) |
| 6 | A D I | GN v CH (250) | MK v JL (50) | OB v FE (150) |
| 7 | C H M | LO v FD (425) | NA v KG (75) | JI v BE (300) |
| 8 | E J O | DL v IA (150) | HB v GM (250) | FC v NK (400) |
| 9 | B K L | DC v MA (175) | FN v IE (150) | JO v HG (250) |
| 10 | F G N | OH v AE (425) | IC v ML (325) | BJ v KD (75) |
| 11 | A D I | EK v LN (250) | MH v FB (325) | GO v CJ (225) |
| 12 | E J M | ND v HL (50) | OI v AC (500) | GF v BK (0) |
| 13 | F H O | NE v BC (350) | GJ v AL (100) | KI v DM (75) |
| 14 | C L N | IH v KJ (100) | DB v OF (375) | AG v ME (250) |

**สูสี (balanced)**

| Round | Sit out | Court 1 | Court 2 | Court 3 |
|---|---|---|---|---|
| 1 | B G J | MC v AO (0) | IH v DN (25) | EL v FK (0) |
| 2 | A C E | KD v BM (0) | HN v OG (0) | LF v IJ (25) |
| 3 | F I L | OB v GJ (0) | HD v KA (0) | ME v CN (25) |
| 4 | H K N | MF v OD (0) | IC v BJ (0) | EG v LA (25) |
| 5 | D M O | FB v AG (0) | NI v LK (0) | JC v EH (0) |
| 6 | A G H | IB v EF (0) | CK v JD (0) | MN v LO (0) |
| 7 | C E I | NL v OK (0) | JF v DM (25) | HA v GB (0) |
| 8 | K N O | BL v MA (0) | JE v FI (0) | HC v DG (0) |
| 9 | B D J | CL v NA (0) | MH v OF (0) | GI v EK (0) |
| 10 | F L M | OJ v KN (0) | IE v HG (25) | BC v DA (0) |
| 11 | B E N | KI v MG (0) | LJ v OH (25) | FA v CD (0) |
| 12 | I J M | KG v OC (0) | FN v LH (0) | BD v AE (0) |
| 13 | C K L | ME v JH (0)* | AO v NB (0)* | DI v FG (0) |
| 14 | F H O | EC v GA (0)* | NB v DL (0)* | IM v KJ (25) |

**ระดับ (level)**

| Round | Sit out | Court 1 | Court 2 | Court 3 |
|---|---|---|---|---|
| 1 | E F O | IG v AB (325) | KM v NL (50) | HC v DJ (75) |
| 2 | I J K | HG v EF (100) | CB v DA (0) | OL v MN (0) |
| 3 | A B G | MO v HN (150) | LK v JI (100) | FD v EC (50) |
| 4 | J K L | GE v FH (50) | CA v BD (50) | NO v IM (175) |
| 5 | E G H | FA v BJ (125) | NK v LM (0) | IO v CD (425) |
| 6 | M N O | DE v FC (0) | IH v GJ (0) | BK v AL (0) |
| 7 | E K L | DO v FJ (75) | BG v NC (200) | HM v AI (275) |
| 8 | I J O | KL v MN (100)** | DC v BA (100)** | FG v EH (0) |
| 9 | F K L | AN v CO (75) | EB v DM (250) | HJ v IG (50)* |
| 10 | M N O | EF v GH (100)** | LI v KJ (0) | CA v BD (50)** |
| 11 | B C D | IH v GJ (0)** | ML v NK (0)** | AE v OF (375) |
| 12 | M N O | IK v JL (50) | CB v DA (0)** | GF v HE (0)** |
| 13 | B K L | GH v IJ (100)** | DE v CF (0)** | ON v AM (375)* |
| 14 | M N O | CD v BA (100)** | JK v LI (0)** | HF v EG (50)** |

