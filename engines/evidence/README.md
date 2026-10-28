# Elo and pairing evidence scripts

Read-only analysis scripts behind G10 and G11 in
[`docs/2026-09-25-engine-evidence-gaps.md`](../../docs/2026-09-25-engine-evidence-gaps.md).
They are not part of the product, the build, or `npm test`
(`test:engines` only globs `engines/*.test.ts`, and `server/tsconfig.build.json`
lists engine files by name).

They answer: is Elo's constant or scale mis-tuned, and does level tagging
change how fair balanced mode's matches are? Rerun them when a group has new
real history, in particular once a group has run สูสี sessions (neither group
analysed so far had).

## Running

Needs Node 22 (`node:sqlite`) and a **copy of a production backup**:

```
# on the server: online backup (safe while the API runs), then copy the .db down
docker compose exec -T api npm run db:backup
scp <host>:jubBad/server/prisma/backups/<newest>.db /somewhere/outside/the/repo/prod.db
```

Group codes are the `Group.code` values in that database. Each script opens the
database read-only. Run from the repo root:

| Script | Args | What it shows |
|---|---|---|
| `elo-replay.mts` | `<db> <group>` | Prediction quality (Brier, log-loss, calibration) by K for one group |
| `elo-k-sweep.mts` | `<db> <groupA> <groupB>` | Constant and decaying K, cross-group check, logistic scale |
| `elo-k-peak.mts` | `<db> <groupA> <groupB>` | K up to 512, rating swing per match, rank stability |
| `tag-accuracy.mts` | `<db> <group>` | Slope and noise of host-set levels against results; tag timing |
| `pairing-sim.mts` | `<db> <groupA> <groupB> [seeds=6] [players=14]` | True match fairness by Elo config and tag quality (slow, ~3 min per 10 seeds) |

```
node --experimental-strip-types --no-warnings engines/evidence/elo-replay.mts <db> <group>
```

## Rules

- **Never commit the database, a backup, or script output.** They hold player
  names and match history. Group and player names appear in the output of
  `elo-replay.mts` and `tag-accuracy.mts` only at run time.
- Record findings in the evidence doc anonymised ("group A", "group B"), as G10 does.

## Caveats worth knowing before trusting a number

- `pairing-sim.mts` fits "true skill" from the same matches it then simulates,
  with the same team-average logistic model as Elo, which favours Elo. Single
  seeds are noisy: equivalent configs differ by 0.02-0.04 in one seed, so use 8+
  and treat differences under about 0.01 as noise.
- `tag-accuracy.mts` needs levels; it can only measure tags that were set, and
  they were all set after the host had watched the player.
- The simulation plays whole rounds, not independently rotating courts.
