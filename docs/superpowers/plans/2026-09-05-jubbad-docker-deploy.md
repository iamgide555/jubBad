# JubBad Docker Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dockerize JubBad (NestJS + Angular + SQLite) and deploy it to the home PC server behind Cloudflare Tunnel at `jubbad.wongnok.dev`, mirroring the proven weddingInvitation pattern.

**Architecture:** Three docker-compose services — `api` (NestJS, SQLite file DB, no host port), `web` (nginx serving the built Angular SPA + reverse-proxying `/api/`, no host port), `cloudflared` (dedicated tunnel, reaches `web` over the internal docker network). No DB container — SQLite is a bind-mounted file, same as weddingInvitation.

**Tech Stack:** NestJS 12 (server), Prisma 7 + `@prisma/adapter-better-sqlite3`, Angular 22 (web), nginx, Docker Compose, Cloudflare Tunnel (`cloudflared`).

**Spec:** `docs/superpowers/specs/2026-09-05-jubbad-docker-deploy-design.md`

## Global Constraints

- No host-published ports on any app-facing service (`api`, `web`) — cloudflared reaches them by docker-compose service name over the internal network only. (Spec: "Docker architecture"; also `homeserver-no-host-ports` project convention.)
- `server` Docker build context is the **repo root**, not `server/` — `tsconfig.build.json` sets `rootDir: ".."` and includes `../engines/{parser,fuzzy-match,pairing}.ts`.
- No auth/secrets scaffolding (`ADMIN_TOKEN` or equivalent) — v1 has no login, per `PROJECT.md`.
- `prisma migrate deploy` runs automatically on every container start (in the image's `CMD`) — no manual one-shot seed step.
- Domain: `jubbad.wongnok.dev`. Server: `iamgide@100.118.30.121` (Tailscale), app dir `/home/iamgide/jubBad`.
- All `import` paths in `server/src` use explicit `.js` extensions (NodeNext module resolution) even though the source files are `.ts` — follow this in every new/modified `server/src` file.

---

### Task 1: Rename branding (title, PROJECT.md heading)

**Files:**
- Modify: `web/src/index.html:5`
- Modify: `PROJECT.md:1`

**Interfaces:** None — text-only changes, no other task depends on these.

- [ ] **Step 1: Update the browser tab title**

In `web/src/index.html`, change:
```html
  <title>Court Pairing</title>
```
to:
```html
  <title>JubBad</title>
```

- [ ] **Step 2: Update the PROJECT.md heading**

In `PROJECT.md`, change the first line:
```markdown
# Badminton court pairing app
```
to:
```markdown
# JubBad — Badminton court pairing app
```

- [ ] **Step 3: Verify no other references to the old browser title remain**

Run: `grep -rn "Court Pairing" web/src PROJECT.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add web/src/index.html PROJECT.md
git commit -m "chore: rename app to JubBad in title and PROJECT.md"
```

---

### Task 2: Restrict CORS to configured origins

**Files:**
- Create: `server/src/cors.ts`
- Test: `server/src/cors.spec.ts`
- Modify: `server/src/main.ts`
- Modify: `server/.env.example`

**Interfaces:**
- Produces: `parseCorsOrigins(raw: string | undefined): boolean | string[]` — exported from `server/src/cors.ts`. Returns `true` (permissive, dev default) when `raw` is `undefined` or blank; otherwise returns a trimmed, non-empty array of origins split on `,`.

- [ ] **Step 1: Write the failing test**

Create `server/src/cors.spec.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from './cors.js';

describe('parseCorsOrigins', () => {
  it('returns true (permissive) when unset', () => {
    expect(parseCorsOrigins(undefined)).toBe(true);
  });

  it('returns true (permissive) when blank', () => {
    expect(parseCorsOrigins('')).toBe(true);
    expect(parseCorsOrigins('   ')).toBe(true);
  });

  it('returns a single-origin array', () => {
    expect(parseCorsOrigins('https://jubbad.wongnok.dev')).toEqual([
      'https://jubbad.wongnok.dev',
    ]);
  });

  it('splits and trims a comma-separated list', () => {
    expect(parseCorsOrigins('https://a.example, https://b.example ,https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('drops empty entries from trailing commas', () => {
    expect(parseCorsOrigins('https://a.example,')).toEqual(['https://a.example']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npm test -- src/cors.spec.ts`
Expected: FAIL — `Cannot find module './cors.js'` (or similar resolution error), since `cors.ts` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/cors.ts`:
```typescript
export function parseCorsOrigins(raw: string | undefined): boolean | string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `npm test -- src/cors.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into bootstrap**

In `server/src/main.ts`, change:
```typescript
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
```
to:
```typescript
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { parseCorsOrigins } from './cors.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: parseCorsOrigins(process.env.CORS_ORIGINS) });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
```

- [ ] **Step 6: Document the env var**

In `server/.env.example`, change:
```
DATABASE_URL="file:./prisma/dev.db"
```
to:
```
DATABASE_URL="file:./prisma/dev.db"

# Comma-separated list of allowed origins for CORS. Leave unset (or blank)
# for permissive CORS — the local dev default. Docker/prod sets this to the
# real origin, e.g. CORS_ORIGINS=https://jubbad.wongnok.dev
CORS_ORIGINS=
```

- [ ] **Step 7: Run the full server test suite**

Run (from `server/`): `npm test`
Expected: PASS, no regressions (existing `app.controller.spec.ts` and others unaffected).

- [ ] **Step 8: Commit**

```bash
git add server/src/cors.ts server/src/cors.spec.ts server/src/main.ts server/.env.example
git commit -m "feat: restrict CORS to CORS_ORIGINS env var, permissive by default"
```

---

### Task 3: `server/Dockerfile` and root `.dockerignore`

**Files:**
- Create: `server/Dockerfile`
- Create: `.dockerignore` (repo root — both `server` and `web` Dockerfiles build with context `.`)

**Interfaces:**
- Consumes: `server/package.json` scripts `build` (`nest build`) and the compiled output path `dist/server/src/main.js` (from `server/tsconfig.build.json`'s `rootDir: ".."`, already producing `dist/server/src/main.js` today per the existing `start:prod` script).
- Produces: a `jubbad-api` image whose `CMD` runs `prisma migrate deploy` then starts the compiled app on `$PORT` (default `3000`), reading `DATABASE_URL` and `CORS_ORIGINS` from the environment.

- [ ] **Step 1: Create the root `.dockerignore`**

Create `.dockerignore`:
```
node_modules/
**/node_modules/
dist/
**/dist/
.angular/
.git/
.DS_Store
**/.env
server/prisma/dev.db
server/prisma/dev.db-journal
server/prisma/dev.db-wal
server/prisma/dev.db-shm
*.tsbuildinfo
docs/
```

- [ ] **Step 2: Write `server/Dockerfile`**

Create `server/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
COPY engines ./engines
COPY server ./server
WORKDIR /repo/server
RUN npm ci
RUN npx prisma generate
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/server/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/prisma ./prisma
COPY --from=build /repo/server/package.json ./package.json
# /app/prisma must be writable by whatever PUID/PGID runs the container —
# the bind-mounted dev.db lives here, and SQLite's WAL mode (enabled in
# PrismaService.onModuleInit) creates sibling -wal/-shm files in this same
# directory at runtime. Matches weddingInvitation's identical /app 1777 fix.
RUN chmod 1777 /app/prisma
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/src/main.js"]
```

- [ ] **Step 3: Build the image**

Run (from repo root): `docker build -f server/Dockerfile -t jubbad-api-test .`
Expected: build succeeds, ends with the image tagged `jubbad-api-test`.

- [ ] **Step 4: Smoke-test the image standalone**

```bash
SMOKE_DIR=$(mktemp -d)
touch "$SMOKE_DIR/dev.db"
docker run --rm -d --name jubbad-api-smoke \
  -e DATABASE_URL="file:/app/prisma/dev.db" \
  -e CORS_ORIGINS="https://jubbad.wongnok.dev" \
  -e PORT=3000 \
  -v "$SMOKE_DIR/dev.db:/app/prisma/dev.db" \
  -p 3000:3000 \
  jubbad-api-test
sleep 2
curl -s http://localhost:3000/
echo
docker logs jubbad-api-smoke
docker stop jubbad-api-smoke
rm -rf "$SMOKE_DIR"
```
Expected: `curl` prints `Hello World!`; `docker logs` shows `prisma migrate deploy` applying migrations with no errors and Nest's normal startup log, no crash-loop.

- [ ] **Step 5: Commit**

```bash
git add server/Dockerfile .dockerignore
git commit -m "feat: add server Dockerfile (repo-root build context)"
```

---

### Task 4: `web/Dockerfile` and `web/nginx.conf`

**Files:**
- Create: `web/Dockerfile`
- Create: `web/nginx.conf`

**Interfaces:**
- Consumes: `web/package.json`'s `build` script (`ng build`). Angular's application builder with no explicit `outputPath` in `web/angular.json` defaults to `dist/<project-name>/browser` — expected `dist/web/browser`. **If the build step below shows a different path, update the `COPY --from=build` line to match and note the correction in the commit message.**
- Produces: a `jubbad-web` image serving the SPA on port 80 and reverse-proxying `/api/` to `http://api:3000/`.

- [ ] **Step 1: Write `web/nginx.conf`**

Create `web/nginx.conf`:
```nginx
server {
    listen 80;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;

    gzip on;
    gzip_types application/json;
    gzip_min_length 1024;

    location /api/ {
        proxy_pass http://api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri /index.html;
    }
}
```

- [ ] **Step 2: Write `web/Dockerfile`**

Create `web/Dockerfile`. Angular 22 requires Node >= 22.22.3 (or 24.15.0+, or 26+) — pin the build stage to `node:24-slim` to clear that floor reliably:
```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM nginx:alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
```

- [ ] **Step 3: Build the image**

Run (from repo root): `docker build -f web/Dockerfile -t jubbad-web-test .`
Expected: build succeeds. If the `COPY --from=build` step fails with "not found", run `docker run --rm jubbad-web-test-build-stage-name find /repo/web/dist -maxdepth 2` (or re-run just the build stage: `docker build -f web/Dockerfile --target build -t jubbad-web-build-debug . && docker run --rm jubbad-web-build-debug find dist -maxdepth 2`) to find the real output path, fix the `COPY` line, and rebuild.

- [ ] **Step 4: Smoke-test the image standalone**

```bash
docker run --rm -d --name jubbad-web-smoke -p 8080:80 jubbad-web-test
sleep 1
curl -s http://localhost:8080/ | grep -o '<title>JubBad</title>'
docker stop jubbad-web-smoke
```
Expected: prints `<title>JubBad</title>` (confirms Task 1's rename made it into the built bundle and nginx serves `index.html` at `/`). The `/api/` proxy path is verified in Task 5's compose smoke test, once `api` is reachable on the same docker network.

- [ ] **Step 5: Commit**

```bash
git add web/Dockerfile web/nginx.conf
git commit -m "feat: add web Dockerfile (nginx + Angular build)"
```

---

### Task 5: `docker-compose.yml`, root `.env.example`, `.gitignore`, and full-stack smoke test

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example` (root)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the `jubbad-api`/`jubbad-web`-equivalent images built by `server/Dockerfile` and `web/Dockerfile` (Tasks 3-4), `${PUID}`/`${PGID}` from the root `.env`.
- Produces: `docker compose up -d --build` brings up `api`, `web`, `cloudflared` with no host-published ports — the deployable unit `dockerDeploy.md` (Task 6) will document driving.

- [ ] **Step 1: Update `.gitignore`**

In `.gitignore`, add:
```
.env
server/.env
server/prisma/dev.db
server/prisma/dev.db-journal
server/prisma/dev.db-wal
server/prisma/dev.db-shm
```

- [ ] **Step 2: Create the root `.env.example`**

Create `.env.example`:
```
# PUID/PGID for docker-compose ${PUID}/${PGID} interpolation — must match
# the host user that owns server/prisma/dev.db, so the containers (which
# run as this uid:gid) can read/write it and cloudflared can read
# ~/.cloudflared's credentials file.
PUID=1000
PGID=1000
```

- [ ] **Step 3: Write `docker-compose.yml`**

Create `docker-compose.yml`:
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

- [ ] **Step 4: Local full-stack smoke test — set up fixtures**

```bash
touch server/prisma/dev.db
cp .env.example .env
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" > .env
cp server/.env.example server/.env
# local smoke test only — CORS_ORIGINS value doesn't matter here since
# nothing calls the API cross-origin in this test, only same-network curl
```

- [ ] **Step 5: Bring the stack up (without cloudflared, which needs real tunnel creds)**

```bash
docker compose up -d --build api web
docker compose ps
```
Expected: both `api` and `web` show `Up`, no restart-looping (check `docker compose ps` again after a few seconds — a crash-looping container cycles through `Restarting`).

- [ ] **Step 6: Verify the API is reachable through nginx's `/api/` proxy**

```bash
docker run --rm --network jubbad_default curlimages/curl -s http://web:80/api/
```
Expected: `Hello World!` (nginx strips `/api/` per the trailing-slash `proxy_pass`, hitting the Nest app's `/` route). If the network name doesn't match, run `docker network ls` first — Compose names it `<project-dir>_default` (the directory is `jubBad`, so likely `jubbad_default` — confirm the exact name from `docker network ls` rather than assuming).

- [ ] **Step 7: Verify the SPA is served at `/`**

```bash
docker run --rm --network jubbad_default curlimages/curl -s http://web:80/ | grep -o '<title>JubBad</title>'
```
Expected: prints `<title>JubBad</title>`.

- [ ] **Step 8: Tear down the smoke test**

```bash
docker compose down
rm -f .env server/.env server/prisma/dev.db
git status   # confirm no fixture files leaked into the working tree
```
Expected: `git status` shows only the new/modified files from this task (`docker-compose.yml`, `.env.example`, `.gitignore`) — `.env`, `server/.env`, and `server/prisma/dev.db` are gone (ignored + deleted).

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.example .gitignore
git commit -m "feat: add docker-compose.yml for api/web/cloudflared"
```

---

### Task 6: `dockerDeploy.md`

**Files:**
- Create: `dockerDeploy.md` (repo root)

**Interfaces:** None — documentation only, consumed by a human running the deploy (Task 7) and future routine deploys.

- [ ] **Step 1: Write `dockerDeploy.md`**

Create `dockerDeploy.md`, adapted from weddingInvitation's `dockerDeploy.md` structure for JubBad's specifics (no seed step — migrations run automatically in the `api` container's `CMD`; no file-upload dirs):

```markdown
# Docker Deployment Steps

Docker Compose deploy for the PC server, mirroring the pattern already
proven for weddingInvitation/palmjam-bot/clockMe on the same box.

## Infrastructure
- Server: PC (`i7-8700`, 16GB) — `/home/iamgide/jubBad`
- Domain: `jubbad.wongnok.dev` via a dedicated Cloudflare Tunnel (`jubbad`)
- Flow: browser → Cloudflare Edge → cloudflared(container) → web/nginx(container):80 → api(container):3000

## Deploy variables (Mac)
\`\`\`bash
export SERVER_HOST=iamgide@100.118.30.121
export APP_DIR=/home/iamgide/jubBad
\`\`\`

## First-time PC setup
1. Docker + Compose already installed on this PC (shared across projects) — confirm with `docker --version && docker compose version`.
2. Clone: `git clone git@github.com:iamgide555/jubBad.git /home/iamgide/jubBad && cd $_`
3. App env: `cp server/.env.example server/.env`, then set:
   \`\`\`
   DATABASE_URL="file:/app/prisma/dev.db"
   CORS_ORIGINS=https://jubbad.wongnok.dev
   \`\`\`
   **`DATABASE_URL` must be the container-internal path (`/app/prisma/dev.db`)** — matches the `docker-compose.yml` bind mount, same class of gotcha weddingInvitation's doc warns about.
4. Root env (PUID/PGID for compose): `printf 'PUID=%s\nPGID=%s\n' "$(id -u iamgide)" "$(id -g iamgide)" > .env`
5. DB file: `touch server/prisma/dev.db && sudo chown "$(id -u):$(id -g)" server/prisma/dev.db`
   (The `touch` matters: if `server/prisma/dev.db` doesn't exist as a **file** before `up`, Docker creates the bind-mount source as a **directory** and `api` crash-loops.)
6. cloudflared tunnel (dedicated to this project):
   \`\`\`bash
   cloudflared tunnel create jubbad
   cloudflared tunnel route dns jubbad jubbad.wongnok.dev
   \`\`\`
   Then add an entry to the server's shared `~/.cloudflared/config.yml` (check the existing file for weddingInvitation/palmjam-bot's convention first — if it's one config per tunnel ID rather than one shared file, create `~/.cloudflared/<jubbad-tunnel-id>.yml` instead, matching whatever's already there):
   \`\`\`yaml
   tunnel: <jubbad-tunnel-id>
   credentials-file: /etc/cloudflared/<jubbad-tunnel-id>.json
   ingress:
     - hostname: jubbad.wongnok.dev
       service: http://web:80
     - service: http_status:404
   \`\`\`
7. Bring up: `docker compose up -d --build`
   (No seed step — `prisma migrate deploy` runs automatically inside the `api` container's startup command on every boot.)

## Routine deploy
\`\`\`bash
# Mac
git push
# PC
ssh "$SERVER_HOST"
cd "$APP_DIR"
git pull
docker compose up -d --build
\`\`\`

## Manage
\`\`\`bash
docker compose ps
docker compose logs -f api
docker compose restart api
docker compose down
docker compose up -d --build
\`\`\`

## Verify
\`\`\`bash
docker compose ps                   # all Up, no host ports listed
curl -I https://jubbad.wongnok.dev  # 200 via tunnel
\`\`\`

## Rollback
\`\`\`bash
git checkout <prev-sha>
docker compose up -d --build        # data intact (bind mount)
\`\`\`

## Troubleshooting
- **`unable to open database file` (api crash-loops immediately):** `server/prisma/dev.db` got created as a root-owned **directory** instead of a file — happens if `docker compose up` ran before the `touch` in step 5. Fix: `docker compose down && sudo rmdir server/prisma/dev.db && touch server/prisma/dev.db && sudo chown "$(id -u):$(id -g)" server/prisma/dev.db`, then `docker compose up -d --build`.
- **`attempt to write a readonly database`:** confirm root `.env` has correct `PUID`/`PGID` and `server/prisma/dev.db` on the host is owned by that uid. The image sets `/app/prisma` mode `1777` so SQLite's WAL journal (`-wal`/`-shm` files) can be created there regardless — a wrong PUID/PGID is the usual remaining cause.
- **`/api/*` returns 404:** nginx must proxy with the trailing slash (`proxy_pass http://api:3000/;`) so the `/api/` prefix is stripped. Rebuild `web` if `web/nginx.conf` changed.
- **cloudflared crash-loops with `permission denied` opening its config:** confirm `user: "${PUID}:${PGID}"` is set in `docker-compose.yml`'s `cloudflared` service (already is) and matches the host user owning `~/.cloudflared`.
```

- [ ] **Step 2: Cross-check every path/command in the doc against the actual repo**

Run: `grep -n "server/prisma/dev.db\|docker-compose.yml\|server/.env" dockerDeploy.md`
Manually confirm each referenced path (`server/prisma/dev.db`, `server/.env`, `docker-compose.yml`) matches what Tasks 2-5 actually created — fix any drift.

- [ ] **Step 3: Commit**

```bash
git add dockerDeploy.md
git commit -m "docs: add dockerDeploy.md for JubBad"
```

---

### Task 7: Push to the new `jubBad` GitHub repo

**Files:** None — git operations only.

**Interfaces:** None — terminal task.

This task pushes to a shared remote (visible to GitHub, and the eventual clone target for the PC server) — **confirm with the user immediately before running Step 2**, even though it's already been discussed, per the standing rule on actions visible to others.

- [ ] **Step 1: Confirm no `origin` remote exists yet**

Run: `git remote -v`
Expected: no output (empty) — this repo has never had a remote configured.

- [ ] **Step 2: Add the remote and push**

```bash
git remote add origin git@github.com:iamgide555/jubBad.git
git push -u origin main
```
Expected: push succeeds, prints the new branch tracking info.

- [ ] **Step 3: Verify**

Run: `git remote -v && git log --oneline -1`
Expected: `origin` points at `git@github.com:iamgide555/jubBad.git` (fetch + push), and the latest local commit matches what's now on GitHub (spot-check via `gh repo view iamgide555/jubBad --json defaultBranchRef` or just visiting the repo).

---

## Self-Review Notes

- **Spec coverage:** rename (Task 1), CORS lockdown (Task 2), `server/Dockerfile` + repo-root context (Task 3), `web/Dockerfile` + nginx (Task 4), `docker-compose.yml` + no-host-ports + env files (Task 5), `dockerDeploy.md` (Task 6), git remote + push (Task 7). The spec's "Open items" (Angular output path, cloudflared config layout on the server) are handled as in-task verification/fallback steps (Task 4 Step 3, Task 6's step 6 note) rather than blocking the plan.
- **Type consistency:** `parseCorsOrigins` signature (Task 2) matches its one call site in `main.ts` (Task 2 Step 5) — no other task references it.
- **No placeholders:** every code/config block is complete and copy-pasteable; the two spec "open items" are resolved with a concrete default (`dist/web/browser`) plus an explicit, executable fallback procedure rather than left as TODOs.
