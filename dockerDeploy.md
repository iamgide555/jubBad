# Docker Deployment Steps

Docker Compose deploy for the PC server, mirroring the pattern already
proven for weddingInvitation/palmjam-bot/clockMe on the same box.

## Infrastructure
- Server: PC (`i7-8700`, 16GB) — `/home/iamgide/jubBad`
- Domain: `jubbad.wongnok.dev` via a dedicated Cloudflare Tunnel (`jubbad`)
- Flow: browser → Cloudflare Edge → cloudflared(container) → web/nginx(container):80 → api(container):3000

## Deploy variables (Mac)
```bash
export SERVER_HOST=iamgide@100.118.30.121
export APP_DIR=/home/iamgide/jubBad
```

## First-time PC setup
1. Docker + Compose already installed on this PC (shared across projects) — confirm with `docker --version && docker compose version`.
2. Clone: `git clone git@github.com:iamgide555/jubBad.git /home/iamgide/jubBad && cd $_`
3. App env: `cp server/.env.example server/.env`, then set:
   ```
   DATABASE_URL="file:/app/prisma/dev.db"
   CORS_ORIGINS=https://jubbad.wongnok.dev
   ```
   **`DATABASE_URL` must be the container-internal path (`/app/prisma/dev.db`)** — matches the `docker-compose.yml` bind mount. `server/.env.example`'s default (`file:./prisma/dev.db`) is for local dev only (`nest start`, run from `server/`) — using it verbatim in Docker causes "unable to open database file" even though the host file exists, since the container only ever sees the file at `/app/prisma/dev.db`.
4. Root env (PUID/PGID for compose): `printf 'PUID=%s\nPGID=%s\n' "$(id -u iamgide)" "$(id -g iamgide)" > .env`
5. DB file: `touch server/prisma/dev.db && sudo chown "$(id -u):$(id -g)" server/prisma/dev.db`
   (The `touch` matters: if `server/prisma/dev.db` doesn't exist as a **file** before `up`, Docker creates the bind-mount source as a **directory** and `api` crash-loops with "unable to open database file".)
6. cloudflared tunnel (dedicated to this project — not reusing weddingInvitation's or palmjam-bot's):
   ```bash
   cloudflared tunnel create jubbad
   cloudflared tunnel route dns jubbad jubbad.wongnok.dev
   ```
   `create` prints a tunnel UUID and writes `~/.cloudflared/<UUID>.json` (credentials file). Then add this project's ingress — check how weddingInvitation/palmjam-bot's tunnels are configured on this server first (one shared `~/.cloudflared/config.yml` vs. one file per tunnel) and follow the same convention:
   ```yaml
   tunnel: <jubbad-tunnel-id>
   credentials-file: /etc/cloudflared/<jubbad-tunnel-id>.json
   ingress:
     - hostname: jubbad.wongnok.dev
       service: http://web:80
     - service: http_status:404
   ```
   `credentials-file` uses the **container** path (`/etc/cloudflared/...`) since `~/.cloudflared` mounts read-only into the container at that path. `service` targets the container DNS name `web:80` (the `web` service in `docker-compose.yml`), not `127.0.0.1`.
7. Bring up: `docker compose up -d --build`
   (No seed step — `prisma migrate deploy` runs automatically inside the `api` container's startup command (`server/Dockerfile`'s `CMD`) on every boot. Safe to re-run; unlike a seed script it doesn't touch existing data.)

## Routine deploy
```bash
# Mac
git push
# PC
ssh "$SERVER_HOST"
cd "$APP_DIR"
git pull
docker compose up -d --build
```

## Manage
```bash
docker compose ps
docker compose logs -f api
docker compose restart api
docker compose down
docker compose up -d --build
```

## Verify
```bash
docker compose ps                   # api/web show Up, no host ports listed (e.g. "3000/tcp" not "0.0.0.0:3000->3000/tcp")
curl -I https://jubbad.wongnok.dev  # 200 via tunnel
```

## Rollback
```bash
git checkout <prev-sha>
docker compose up -d --build        # data intact (bind mount)
```

## Troubleshooting
- **`unable to open database file`** (api crash-loops immediately): two distinct causes, check both —
  1. `server/prisma/dev.db` got created as a root-owned **directory** instead of a file — happens if `docker compose up` ran before the `touch` in step 5. Fix: `docker compose down && sudo rmdir server/prisma/dev.db && touch server/prisma/dev.db && sudo chown "$(id -u):$(id -g)" server/prisma/dev.db`, then `docker compose up -d --build`.
  2. `server/.env`'s `DATABASE_URL` is the local-dev relative path (`file:./prisma/dev.db`) instead of the container-internal path. Fix: set `DATABASE_URL="file:/app/prisma/dev.db"` in `server/.env`, then `docker compose down && docker compose up -d --build` (a plain `restart` won't reload `env_file` changes — the container must be recreated).
- **`attempt to write a readonly database`:** confirm root `.env` has correct `PUID`/`PGID` (`id -u iamgide` / `id -g iamgide`) and `server/prisma/dev.db` on the host is owned by that uid. `server/Dockerfile` sets `/app/prisma` mode `1777` so SQLite's WAL journal (`-wal`/`-shm` files, enabled in `PrismaService.onModuleInit`) can be created there regardless of the container's uid — a wrong PUID/PGID is the usual remaining cause.
- **`prisma migrate deploy` fails with a datasource/config error at container startup:** `server/Dockerfile`'s runtime stage must include `prisma7.config.ts` alongside `dist/`, `prisma/`, and `node_modules/` — the CLI reads `DATABASE_URL` through that config file, not directly. Check the file is present: `docker compose exec api ls prisma7.config.ts`.
- **`/api/*` returns 404:** nginx must proxy with the trailing slash (`proxy_pass http://$upstream_api/;` in `web/nginx.conf`) so the `/api/` prefix is stripped. Rebuild `web` if `web/nginx.conf` changed.
- **`web` container exits immediately with `host not found in upstream "api"`:** shouldn't happen with the current `web/nginx.conf` (it resolves `api` lazily via Docker's embedded DNS resolver, `127.0.0.11`) — if it recurs, confirm the `resolver` directive and `set $upstream_api api:3000;` + `proxy_pass http://$upstream_api/;` pattern weren't reverted to a bare `proxy_pass http://api:3000/;`, which resolves eagerly at nginx startup and crashes if `api` isn't reachable yet.
- **cloudflared crash-loops with `permission denied` opening its config:** confirm `user: "${PUID}:${PGID}"` is set in `docker-compose.yml`'s `cloudflared` service (already is) and matches the host user owning `~/.cloudflared`.
