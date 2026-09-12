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
   SESSION_SECRET=<paste the output of: openssl rand -base64 32>
   ADMIN_EMAIL=<the first admin's email>
   ADMIN_PASSWORD=<a real password — change it from the admin console after first login>
   DATABASE_URL="file:/app/prisma/dev.db"
   CORS_ORIGINS=https://jubbad.wongnok.dev
   ```
   **`SESSION_SECRET` signs the session cookie.** The API refuses to start
   without it, deliberately: an unset secret must never degrade to "sign
   cookies with nothing" or "verify none of them", which would be invisible in
   production — the site would come up and work perfectly until a session was
   silently rejected. If the `api` container exits immediately on a deploy,
   check this first (`docker compose logs api` shows `SESSION_SECRET is not
   set`). Changing the value signs out every user on every device at once — the
   coarse, emergency-only revocation; disabling one user from the admin
   console is per-user and does not need this.
   **`ADMIN_EMAIL`/`ADMIN_PASSWORD` seed the first admin account and are read
   only when no admin exists yet** — on every boot after that, both are safe to
   remove from `server/.env` entirely. Change the password from the admin
   console rather than leaving a working one sitting in this file indefinitely.
   Existing groups (from a prior deploy without accounts) are all assigned to
   this admin on first boot; reassign each to its real host afterward from the
   admin console.
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

### When the release contains a migration

`server/Dockerfile` runs `prisma migrate deploy` at container start, so
migrations apply themselves on deploy — there is no separate command to run,
and no prompt if one is going to fail. Check first when `git pull` brought in
anything under `server/prisma/migrations/`:

```bash
# PC — snapshot before a schema change. The API is still running, so use the
# online backup rather than copying the file.
cd "$APP_DIR"
docker compose exec -T api npm run db:backup

# If that fails because the image predates the backup script (first deploy of
# it), stop the API and copy the directory instead — with the API down there
# are no in-flight writes to tear.
docker compose stop api
cp -a server/prisma "server/prisma.before-$(date +%Y%m%d-%H%M%S)"
docker compose start api
```

A migration that adds a `UNIQUE` index fails if the existing rows already
violate it, and the container then crash-loops on every restart rather than
starting with an unmigrated schema. The data is not lost — each migration runs
in a transaction and rolls back — but the site is down until the rows are
fixed. Every one of these should return `0`:

```bash
# PC
docker compose exec -T api npx prisma db execute --stdin <<'SQL'
SELECT 'open pairings sharing a court', COUNT(*) FROM
  (SELECT 1 FROM Pairing WHERE endedAt IS NULL GROUP BY sessionId, courtNumber HAVING COUNT(*)>1);
SELECT 'duplicate roster rows', COUNT(*) FROM
  (SELECT 1 FROM SessionRoster GROUP BY sessionId, playerId HAVING COUNT(*)>1);
SELECT 'duplicate waitlist rows', COUNT(*) FROM
  (SELECT 1 FROM Waitlist GROUP BY sessionId, playerId HAVING COUNT(*)>1);
SELECT 'roster rows with no player', COUNT(*) FROM
  SessionRoster r LEFT JOIN Player p ON p.id = r.playerId WHERE p.id IS NULL;
SELECT 'waitlist rows with no player', COUNT(*) FROM
  Waitlist w LEFT JOIN Player p ON p.id = w.playerId WHERE p.id IS NULL;
SQL
```

Then deploy, and confirm the migration actually applied rather than assuming a
running container means a migrated one:

```bash
# PC
docker compose up -d --build
docker compose logs api | grep -i "migration"   # names each migration applied
docker compose ps                               # api Up, not Restarting
```

If `api` is restarting, `docker compose logs api` names the failing migration.
Restore from the snapshot taken above before retrying — see **Restore**.

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

### Reset to an empty database

Starting the season over, or clearing test data after a trial run. There is no
"reset" command and deliberately so: the procedure is to delete the database and
let the API rebuild it, because `server/Dockerfile` already runs
`prisma migrate deploy` on every boot.

```bash
# PC
cd "$APP_DIR"
docker compose exec -T api npm run db:backup   # irreversible past this point
docker compose stop api                        # no writes may be in flight
rm -f server/prisma/dev.db server/prisma/dev.db-wal server/prisma/dev.db-shm
docker compose start api
docker compose logs --tail=20 api              # "All migrations have been successfully applied."
```

**Delete all three files, not just `dev.db`.** The database runs in WAL mode, so
committed writes sit in `dev.db-wal` until a checkpoint folds them back. Remove
the database alone and SQLite replays the journal into the newly created file —
a half-reset that resurrects some of the very data you meant to discard, which
is far worse than not resetting at all.

**This now signs everyone out, and deletes every account.** Before per-user
login (B12) there was no user table and the admin login was one secret in
`server/.env` — this reset touched nothing under `src/auth/`. That is no
longer true: `User`, `PasswordReset` and `PasswordResetRequest` are ordinary
tables in `dev.db`, so wiping it deletes every account along with the groups,
players, sessions and pairings. The very next boot re-seeds exactly one admin
from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if they are still set in `server/.env`
(harmless if they are — see the note on those variables above); if they were
already removed after the first real deploy, put them back in `server/.env`
before running this, or the container will refuse to start with no admin and
no way to create one.

To reset *and* deploy in one restart, fold it into the routine deploy:

```bash
# PC
cd "$APP_DIR"
docker compose exec -T api npm run db:backup
git pull
docker compose down
rm -f server/prisma/dev.db server/prisma/dev.db-wal server/prisma/dev.db-shm
docker compose up -d --build
```

## Rollback
```bash
git checkout <prev-sha>
docker compose up -d --build        # data intact (bind mount)
```

## Troubleshooting
- **Rolling back past the per-user-login deploy (B12):** the older image
  requires `ADMIN_TOKEN` and does not know `SESSION_SECRET` /
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` exist — it will crash-loop on boot if
  `server/.env` has already been updated to the new variables and
  `ADMIN_TOKEN` removed. Keep the old `ADMIN_TOKEN` value on hand (do not
  delete it from wherever it was recorded) until this deploy has run a full
  session; if a rollback is needed, put `ADMIN_TOKEN` back in `server/.env`
  before `docker compose up -d --build` on the older image. The reverse
  direction is not a problem: deploying the new image forward again reads
  `SESSION_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD` and ignores `ADMIN_TOKEN`
  if it's still present. Avoid deploying this migration on a session day.
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
