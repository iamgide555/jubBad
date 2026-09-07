# JubBad: rename + Docker deploy design

Date: 2026-09-05

## Context

Project was `badminton-partner` (local dir + no git remote yet). Renamed to
**JubBad**. Goal: dockerize and deploy to the home PC server
(`100.118.30.121`, Tailscale) behind Cloudflare Tunnel, at
`jubbad.wongnok.dev` — mirroring the proven pattern already running for
`weddingInvitation`, `palmjam-bot`, and `clockMe` on that server.

Stack:
- `server/`: NestJS + Prisma (`@prisma/adapter-better-sqlite3`, SQLite file
  DB). Imports shared code from top-level `engines/` (fuzzy-match, pairing,
  parser) via `rootDir: ".."` in `tsconfig.build.json` — **the Docker build
  context for the API must include the repo root, not just `server/`**,
  unlike weddingInvitation's self-contained `backend/`.
- `web/`: Angular 22 SPA, no backend-for-frontend, calls the API directly.
- No auth/login in v1 (per `PROJECT.md`) — no equivalent of
  weddingInvitation's `ADMIN_TOKEN`.
- `main.ts` currently calls `app.enableCors()` with no origin restriction —
  needs locking to the prod origin.

Closest sibling pattern: **weddingInvitation** (SQLite, no DB container) —
not palmjam-bot (Mongo container), since JubBad's data footprint is small
and file-based like weddingInvitation's.

## Non-goals

- No Postgres/Mongo migration — SQLite file is enough at this scale (small
  trusted friend-group data, matches weddingInvitation's precedent).
- No auth/secrets scaffolding — v1 has none per `PROJECT.md` decisions
  table; not adding any as part of this deploy work.
- No CI/CD pipeline — deploy stays manual (`git pull && docker compose up
  -d --build`), same as all three sibling projects today.

## Rename scope

Old name wasn't baked into code (grep for `badminton-partner` /
`badminton partner` across `*.ts/.html/.json/.md` returned nothing) — scope
is small:

- Local dir: `~/Desktop/project/badminton-partner` → `~/Desktop/project/jubBad`
  (done directly, ahead of this spec, since renaming mid-session was cheap
  and reversible).
- `web/src/index.html`: `<title>Court Pairing</title>` → `<title>JubBad</title>`
- `PROJECT.md`: heading gets a JubBad mention (content otherwise unchanged —
  it's a decisions doc, not marketing copy).
- Git: no `origin` was configured on this repo yet. Add
  `origin = git@github.com:iamgide555/jubBad.git`, push full existing
  history (nothing sensitive in it — no reason to squash).
- **Not touching**: `server/package.json` (`name: "server"`) and
  `web/package.json` (`name: "web"`) — these are internal workspace names,
  not project-facing, and the sibling projects don't rename theirs either.

## Docker architecture

Three services, one `docker-compose.yml`, no host-published ports (per the
`homeserver-no-host-ports` pattern already fixed in weddingInvitation this
session) — cloudflared reaches everything over the internal docker network
by service name.

```
browser → Cloudflare Edge → cloudflared(container) → web/nginx(container):80 → api(container):3000
```

### `server/Dockerfile` (new)

Build context must be the **repo root** (not `server/`), because
`tsconfig.build.json` sets `rootDir: ".."` and includes
`../engines/{parser,fuzzy-match,pairing}.ts`. Multi-stage:

1. Build stage: copy repo root (`engines/`, `server/`), `npm ci` in
   `server/`, run `nest build` (outputs `server/dist/server/src/main.js` +
   `server/dist/engines/*.js`, matching the existing `start:prod` script
   `node dist/server/src/main`).
2. Runtime stage: copy `server/dist`, `server/node_modules` (prod deps
   only), `server/prisma` (schema + migrations — needed at runtime for
   `prisma migrate deploy`), generated Prisma client.
3. `CMD`: run `prisma migrate deploy` then `node dist/server/src/main.js`,
   both from `/app` (container workdir = `server/` contents). Safe to run
   `migrate deploy` on every start — idempotent, unlike weddingInvitation's
   one-shot `seed.py` which must NOT be re-run. No separate seed step needed
   here — no seed data in v1.

### `web/Dockerfile` (new) + `web/nginx.conf` (new)

Same shape as weddingInvitation's: multi-stage, `ng build` in stage 1
(Angular 22 default output `dist/web/browser` — confirm exact path at
implementation time), nginx serving static + reverse-proxying `/api/` to
`http://api:3000/` (trailing slash strips the prefix, same gotcha
weddingInvitation's troubleshooting section documents). No `ports:` block —
`expose: "80"` only.

### `docker-compose.yml` (new)

```yaml
services:
  api:
    build:
      context: .
      dockerfile: server/Dockerfile
    restart: always
    env_file: ./server/.env
    user: "${PUID}:${PGID}"
    volumes:
      - ./server/prisma/dev.db:/app/prisma/dev.db
    expose:
      - "3000"

  web:
    build:
      context: .
      dockerfile: web/Dockerfile
    restart: always
    depends_on:
      - api
    expose:
      - "80"

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: always
    depends_on:
      - web
    user: "${PUID}:${PGID}"
    command: tunnel --config /etc/cloudflared/config.yml run
    volumes:
      - ~/.cloudflared:/etc/cloudflared:ro
```

No `photos`/`qr_codes`-equivalent volumes — JubBad has no file uploads in
v1. Root `.env` holds `PUID`/`PGID` only, same as siblings.

### Env / config

- `server/.env` (new, gitignored, `server/.env.example` committed):
  ```
  DATABASE_URL="file:/app/prisma/dev.db"
  CORS_ORIGINS=https://jubbad.wongnok.dev
  PORT=3000
  ```
- `main.ts` changes from `app.enableCors()` (wide open) to
  `app.enableCors({ origin: process.env.CORS_ORIGINS?.split(',') })`,
  matching weddingInvitation's `CORS_ORIGINS` pattern.
- Same SQLite bind-mount-as-file gotcha as weddingInvitation applies here:
  `server/prisma/dev.db` must exist as a **file** (`touch`) before first
  `docker compose up`, or the bind mount creates it as a directory and the
  container crash-loops.

### Cloudflare Tunnel

New dedicated tunnel (own credentials, own config), same as each sibling
project gets its own — not reusing weddingInvitation's or palmjam-bot's
tunnel:

```bash
cloudflared tunnel create jubbad
cloudflared tunnel route dns jubbad jubbad.wongnok.dev
```

`~/.cloudflared/jubbad.yml` (or shared `config.yml` if the server's
cloudflared setup convention differs — check what's already there for the
other two projects before assuming a filename):

```yaml
tunnel: <jubbad-tunnel-uuid>
credentials-file: /etc/cloudflared/<jubbad-tunnel-uuid>.json
ingress:
  - hostname: jubbad.wongnok.dev
    service: http://web:80
  - service: http_status:404
```

### `dockerDeploy.md` (new, at repo root)

Same structure as weddingInvitation's: Infrastructure, deploy variables,
first-time PC setup, routine deploy, manage, verify, rollback,
troubleshooting. Adapted for: no `seed.py` step (migrations run
automatically in the container's `CMD`), no `guests.csv`-equivalent, no
photos dir, `jubbad.wongnok.dev` / tunnel `jubbad` throughout.

## Testing

- Local: `docker compose up -d --build` on Mac (or a scratch dir) to catch
  Dockerfile/build-context mistakes before touching the real server —
  particularly the repo-root build context for `api`, since that's the one
  detail that differs from the weddingInvitation template and is easy to
  get wrong copy-pasting.
- Confirm `/api/*` round-trips through nginx to the NestJS app.
- Confirm CORS: request from `https://jubbad.wongnok.dev` origin succeeds,
  arbitrary origin is rejected once `CORS_ORIGINS` is wired in.
- Server deploy: same verify steps as weddingInvitation's doc — `docker
  compose ps` all Up, `curl -I https://jubbad.wongnok.dev` 200, no
  host-published ports in `docker compose ps` output.

## Open items for implementation time (not blocking spec approval)

- Exact Angular build output path (`dist/web/browser` assumed, confirm via
  actual `ng build` run).
- Whether the PC server's cloudflared credential/config layout is
  per-project files (`<name>.yml`) or something else — check the actual
  `~/.cloudflared/` layout on the server (or ask, since this session has no
  SSH access to it) before writing the exact tunnel config path into
  `dockerDeploy.md`.
