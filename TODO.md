# Badminton app — progress tracker

See `badminton-app-plan.md` for full design/rationale. This file tracks
build-order progress only.

## Design / decisions

- [x] v1 plan written (scope, tech stack, schema, build order)
- [x] Plan reviewed for gaps (8 findings folded in)
- [x] Fuzzy-match algorithm decided (normalized Levenshtein, no fuzzy auto-link)
- [ ] Opponent-balancing scope decision for pairing engine (in/out for v1)
- [ ] Mid-session edit flow designed (reshuffle / late-add / no-show removal)

## Build order

- [x] 1. LINE roster-message parser (`parser.ts`, verified vs 3 real messages)
- [ ] 2. Fuzzy-match layer (parsed names → known `Player` records + `aliases[]`)
- [ ] 3. Pairing/rotation engine (repeat-partner avoidance + sit-out balancing)
- [ ] 4. Cost split + PromptPay QR generation (needs `hostPromptPayId` schema field added to DB)
- [ ] 5. Angular screens: paste → confirm → shuffle → share → score → split

## Infra

- [x] Git repo initialized, `.gitignore` added
- [ ] NestJS backend scaffolded
- [ ] Angular frontend scaffolded
- [ ] DB schema created (Group, Player, Session, Round, Pairing, Waitlist)
