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
   ADMIN_TOKEN=<paste the output of: openssl rand -base64 32>
   DATABASE_URL="file:/app/prisma/dev.db"
   CORS_ORIGINS=https://jubbad.wongnok.dev
   ```
   **`ADMIN_TOKEN` is the admin login.** The API refuses to start without it,
   deliberately: an unset secret must never degrade to "no auth configured, so
   let everyone in", which would be invisible in production — the site would
   come up and work perfectly with the door open. If the `api` container exits
   immediately on a deploy, check this first (`docker compose logs api` shows
   `ADMIN_TOKEN is not set`). Changing the value signs every browser out, which
   is also how you revoke access.
   **`DATABASE_URL` must be the container-internal path (`/app/prisma/dev.db`)** — matches the `docker-compose.yml` bind mount. `server/.env.example`'s default (`file:./prisma/dev.db`) is for local dev only (`nest start`, run from `server/`) — using it verbatim in Docker causes "unable to open database file" even though the host file exists, since the container only ever sees the file at `/app/prisma/dev.db`.
4. Root env (PUID/PGID for compose): `printf 'PUID=%s\nPGID=%s\n' "$(id -u iamgide)" "$(id -g iamgide)" > .env`
5. DB directory: `sudo chown -R "$(id -u):$(id -g)" server/prisma`
   (`docker-compose.yml` bind-mounts the whole `server/prisma` directory, not just `dev.db` — SQLite's WAL mode writes `dev.db-wal`/`dev.db-shm` next to the database, and mounting only the file would strand those in the container's ephemeral layer, losing committed writes on restart. The directory already exists in the repo, so there is no file to `touch` first. `prisma migrate deploy` creates `dev.db` on the first boot.)
6. cloudflared tunnel (dedicated to this project — not reusing weddingInvitation's or palmjam-bot's):
   ```bash
   cloudflared tunnel create jubbad
   cloudflared tunnel route dns jubbad jubbad.wongnok.dev
   ```
   `create` prints a tunnel UUID and writes `~/.cloudflared/<UUID>.json` (credentials file). `~/.cloudflared` is shared across **every** project on this server — weddingInvitation already owns the generic filename `config.yml` there, so this project's config MUST use a project-specific filename (`jubbad.yml`, matching `docker-compose.yml`'s `cloudflared` command) or it will silently load weddingInvitation's tunnel instead (symptom: `docker compose logs cloudflared` shows someone else's `tunnelID`, and the site 530s). Create `~/.cloudflared/jubbad.yml`:
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

## Backup and restore

The database is the only thing on this box that cannot be rebuilt from git, and
it is a single SQLite file. **Do not back it up by copying `dev.db`.** The
database runs in WAL mode, so committed writes sit in `dev.db-wal` until a
checkpoint, and copying the three files reads them at three different instants
while the API is still writing — a torn snapshot that looks fine until you try
to use it. `server/scripts/backup-db.mjs` uses SQLite's online backup API
instead: one consistent, self-contained file, taken without stopping play.

```bash
# PC — one backup now, into server/prisma/backups on the host bind mount
cd "$APP_DIR"
docker compose exec -T api npm run db:backup
```

Every backup is verified with `PRAGMA integrity_check` before the script
reports success, so a bad snapshot fails loudly tonight rather than during a
restore. Retention is 30 days but never fewer than 7 files (`--keep`,
`--min-keep`): age alone would mean that if the scheduler ever stopped, the job
would eventually delete the last copy of the data it exists to protect.

Schedule it nightly, after play has finished:

```bash
# PC — crontab -e
30 2 * * * cd /home/iamgide/jubBad && /usr/bin/docker compose exec -T api npm run db:backup >> /home/iamgide/jubBad-backup.log 2>&1
```

Backups live in the bind-mounted `server/prisma/backups` and are gitignored.
They are on the same disk as the database, which protects against a bad
migration or a mistaken delete but not against losing the machine — copy them
off the box (rsync to another host, or any cloud sync) if that matters.

### Restore

```bash
# PC
cd "$APP_DIR"
ls server/prisma/backups                       # pick one
docker compose stop api                        # nothing may hold the file open
docker compose run --rm --no-deps -T api \
  node scripts/restore-db.mjs prisma/backups/jubbad-<timestamp>.db
docker compose start api
docker compose logs -f api                     # then open a recent session and check it
```

The restore script refuses a backup that fails `integrity_check`, moves the
current database aside as `dev.db.replaced-<timestamp>` rather than
overwriting it (restoring the *wrong* backup must itself be recoverable), and
deletes the stale `-wal`/`-shm` files. That last step is the one people miss by
hand: leave the journal behind and SQLite replays it over the restored file,
handing back some of the data you were trying to discard.

Note that the group JSON export in the app is **not** a restore path — it omits
fairness offsets and activation timestamps, so it cannot reconstruct a session's
rotation state. It is for reading, not recovery.

## Rollback
```bash
git checkout <prev-sha>
docker compose up -d --build        # data intact (bind mount)
```

## Troubleshooting
- **`unable to open database file`** (api crash-loops immediately): two distinct causes, check both —
  1. `server/prisma` on the host isn't writable by `PUID`/`PGID`, so SQLite can't create `dev.db` or its WAL sidecars. Fix: `sudo chown -R "$(id -u):$(id -g)" server/prisma`, then `docker compose up -d --build`.
  2. `server/.env`'s `DATABASE_URL` is the local-dev relative path (`file:./prisma/dev.db`) instead of the container-internal path. Fix: set `DATABASE_URL="file:/app/prisma/dev.db"` in `server/.env`, then `docker compose down && docker compose up -d --build` (a plain `restart` won't reload `env_file` changes — the container must be recreated).
- **`attempt to write a readonly database`:** confirm root `.env` has correct `PUID`/`PGID` (`id -u iamgide` / `id -g iamgide`) and `server/prisma/dev.db` on the host is owned by that uid. `server/Dockerfile` sets `/app/prisma` mode `1777` so SQLite's WAL journal (`-wal`/`-shm` files, enabled in `PrismaService.onModuleInit`) can be created there regardless of the container's uid — a wrong PUID/PGID is the usual remaining cause.
- **`prisma migrate deploy` fails with a datasource/config error at container startup:** `server/Dockerfile`'s runtime stage must include `prisma7.config.ts` alongside `dist/`, `prisma/`, and `node_modules/` — the CLI reads `DATABASE_URL` through that config file, not directly. Check the file is present: `docker compose exec api ls prisma7.config.ts`.
- **`/api/*` returns 404 or reaches the wrong route (e.g. `parse` requests hit Nest's `/` instead of `/groups/:code/parse`):** `web/nginx.conf`'s `/api/` location must strip the prefix via an explicit `rewrite ^/api/(.*)$ /$1 break;` before `proxy_pass http://$upstream_api;` — since `proxy_pass` targets a *variable* (`$upstream_api`, needed for lazy DNS resolution below), nginx can't do its usual automatic prefix-stripping and silently forwards every request as bare `/` if the `rewrite` line is missing or reverted to a plain `proxy_pass http://$upstream_api/;`. Rebuild `web` if `web/nginx.conf` changed.
- **`web` container exits immediately with `host not found in upstream "api"`:** shouldn't happen with the current `web/nginx.conf` (it resolves `api` lazily via Docker's embedded DNS resolver, `127.0.0.11`) — if it recurs, confirm the `resolver` directive and the `set $upstream_api api:3000;` / `rewrite` / `proxy_pass http://$upstream_api;` pattern weren't reverted to a bare `proxy_pass http://api:3000/;`, which resolves eagerly at nginx startup and crashes if `api` isn't reachable yet.
- **Browser console shows `net::ERR_CONNECTION_REFUSED` to `localhost:3000` (site otherwise loads fine):** the production Angular bundle shipped the dev API URL. `web/src/environments/environment.production.ts` (`apiBaseUrl: '/api'`) must exist and `web/angular.json`'s `build.configurations.production.fileReplacements` must swap it in for `environment.ts` — `ng build` defaults to the `production` configuration, so without that wiring it silently ships `environment.ts`'s dev value (`http://localhost:3000`) to real browsers. Rebuild `web` if either file changed.
- **cloudflared crash-loops with `permission denied` opening its config:** confirm `user: "${PUID}:${PGID}"` is set in `docker-compose.yml`'s `cloudflared` service (already is) and matches the host user owning `~/.cloudflared`.
- **`curl -I https://jubbad.wongnok.dev` returns `530`, containers all show `Up`:** cloudflared is running but connected the *wrong tunnel*. Check `docker compose logs cloudflared` — if the logged `tunnelID` isn't jubbad's own UUID (compare against `cloudflared tunnel list`), the container read another project's config. `~/.cloudflared` is shared across every project on this server; `docker-compose.yml`'s `cloudflared` command must point at `/etc/cloudflared/jubbad.yml` specifically (not the generic `config.yml`, which weddingInvitation already owns). Fix: confirm `~/.cloudflared/jubbad.yml` exists with jubbad's own `tunnel:`/`credentials-file:` UUID, confirm the compose command matches that filename, then `docker compose up -d --build cloudflared`.
