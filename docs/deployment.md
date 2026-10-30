# Deploying CodeHere

This guide takes you from an empty server to CodeHere running on your own domain with HTTPS. Pick one path:

- **[Option A — Docker Compose + Caddy](#option-a--docker-compose--caddy-recommended)** (recommended): one command, automatic HTTPS, nothing to install but Docker.
- **[Option B — Node.js + systemd + nginx](#option-b--nodejs--systemd--nginx)**: no containers, if you already run nginx.

Both work with SQLite (default), PostgreSQL or MySQL. Afterwards, see [hardening a public instance](#hardening-a-public-instance), [backups](#backups) and [upgrading](#upgrading).

## Before you start

You need:

- A Linux server with a public IP (1 vCPU and 512 MB RAM is plenty for small teams).
- A domain, e.g. `example.com`. This guide uses:
  - `code.example.com` for the editor (any host name works, including the bare domain)
  - `admin.example.com` for the admin page (optional)
- Ports 80 and 443 open in the server's firewall.

Create DNS **A** (and **AAAA** for IPv6) records for both host names pointing at the server, and wait until they resolve:

```bash
dig +short code.example.com
dig +short admin.example.com
```

> **Why a separate admin host?** CodeHere treats every path on the editor host as a room name, so `/admin` is just a room. The admin page and its API only answer on `ADMIN_HOST`.

---

## Option A — Docker Compose + Caddy (recommended)

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in afterwards
docker compose version          # needs Compose v2.24 or newer
```

### 2. Get the code

```bash
git clone https://github.com/ayenz/CodeHere.git
cd CodeHere
cp .env.example .env
```

### 3. Configure

Edit `.env`. The values that matter for this setup:

```ini
# Domains (both must already point at this server)
DOMAIN=code.example.com
ADMIN_HOST=admin.example.com
ADMIN_PASSWORD=change-me-to-a-long-random-password

# Caddy runs on the same machine, so keep the app port private and trust its headers.
PUBLISH=127.0.0.1:3000
TRUST_PROXY=true
```

Generate a strong admin password with `openssl rand -base64 24`. Leave `ADMIN_PASSWORD` empty to disable the admin page.

### 4. Start

```bash
docker compose --profile https up -d --build
docker compose logs -f app caddy   # Ctrl+C to stop following
```

You should see `[server] listening on http://0.0.0.0:3000` and `admin enabled on host admin.example.com`. Caddy fetches HTTPS certificates on the first request, which can take a few seconds.

Open `https://code.example.com` — you land in a new room. Open `https://admin.example.com` and sign in with `ADMIN_PASSWORD`.

### Using PostgreSQL or MySQL instead of SQLite

SQLite is fine for most installs. To use the bundled PostgreSQL container, add to `.env`:

```ini
DB_DRIVER=postgres
DB_PASSWORD=another-long-random-password
DATABASE_URL=postgres://codehere:another-long-random-password@postgres:5432/codehere
```

and start with both profiles:

```bash
docker compose --profile https --profile postgres up -d --build
```

For MySQL use `DB_DRIVER=mysql`, `DATABASE_URL=mysql://codehere:<password>@mysql:3306/codehere` and `--profile mysql`. To use a managed database (RDS, Cloud SQL, Supabase, PlanetScale…), set `DB_DRIVER` and `DATABASE_URL` to it and leave the database profile off.

The schema is created and migrated automatically when the app starts. The bundled database ports are not published on the host.

### Already running a reverse proxy?

Skip the `https` profile: run `docker compose up -d --build` with `PUBLISH=127.0.0.1:3000` and point your proxy at `127.0.0.1:3000`. See the [nginx example](../deploy/nginx.conf) for the headers WebSockets need.

---

## Option B — Node.js + systemd + nginx

### 1. Install Node.js 22+ and nginx

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
```

### 2. Get, build and configure the code

```bash
sudo useradd --system --create-home --home-dir /opt/codehere codehere
sudo -u codehere git clone https://github.com/ayenz/CodeHere.git /opt/codehere/app
cd /opt/codehere/app
sudo -u codehere npm ci
sudo -u codehere npm run build
sudo -u codehere npm prune --omit=dev
sudo -u codehere mkdir -p data
sudo -u codehere cp .env.example .env
```

Edit `/opt/codehere/app/.env`:

```ini
HOST=127.0.0.1
PORT=3000
SQLITE_PATH=/opt/codehere/app/data/codehere.db
ADMIN_HOST=admin.example.com
ADMIN_PASSWORD=change-me-to-a-long-random-password
TRUST_PROXY=true
```

### 3. Run it as a service

```bash
sudo cp deploy/codehere.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codehere
sudo systemctl status codehere
curl -s http://127.0.0.1:3000/healthz   # → ok
```

### 4. Put nginx in front

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/codehere
sudo sed -i 's/example\.com admin\.example\.com/code.example.com admin.example.com/' /etc/nginx/sites-available/codehere
sudo ln -s /etc/nginx/sites-available/codehere /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The important parts of that config are the `Upgrade`/`Connection` headers (without them real-time editing cannot connect) and passing `Host` through (CodeHere uses it to recognise `ADMIN_HOST`).

### 5. HTTPS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d code.example.com -d admin.example.com
```

---

## Hardening a public instance

Every limit is off by default. If anyone on the internet can reach your instance, set some in `.env` and restart:

```ini
MAX_DOC_CHARS=500000          # ~500 KB of code per room
MAX_MESSAGE_BYTES=2097152     # 2 MB per WebSocket message (a large paste)
MAX_MESSAGES_PER_SECOND=60    # per connection, bursts up to 4x
MAX_CONNECTIONS_PER_IP=20
MAX_NEW_ROOMS_PER_HOUR=60     # per IP
MAX_ACTIVE_ROOMS=2000
ROOM_TTL_DAYS=90              # delete rooms nobody edited for 90 days
```

Also:

- Keep `TRUST_PROXY=true` **only** when CodeHere is reachable solely through your proxy (`PUBLISH=127.0.0.1:3000`, the default, or `HOST=127.0.0.1`). Otherwise clients could fake their IP and dodge per-IP limits. CodeHere uses the right-most `X-Forwarded-For` entry, the one your proxy adds; the nginx example sets it to the real client address.
- Use a long, random `ADMIN_PASSWORD`. Sign-in attempts are limited to 5 per minute per IP. The session cookie is `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS.
- Anyone with a room's edit link can edit it — share view-only links when people only need to read.

## What CodeHere stores

| Data | Where | How long |
|---|---|---|
| Room content (Yjs document), language, view-link ID, lock flag, created/updated time | Database | Until deleted by the creator, an admin, or `ROOM_TTL_DAYS` |
| SHA-256 of the room creator's secret token | Database | With the room |
| Names, colours and cursors of people in a room | Server memory only | While they are connected |
| Display name, theme and editor settings | The visitor's browser (`localStorage`) | Until they clear it |
| Admin sessions | Server memory | 12 hours, or until restart |

CodeHere does not log IP addresses or room content.

## Backups

**SQLite (Docker):**

```bash
docker compose exec app node -e "require('better-sqlite3')('/data/codehere.db').backup('/data/backup.db').then(() => console.log('done'))"
docker compose cp app:/data/backup.db ./codehere-$(date +%F).db
```

**SQLite (systemd):** `sudo apt-get install -y sqlite3`, then `sqlite3 /opt/codehere/app/data/codehere.db ".backup '/opt/codehere/backup.db'"` (works while the app runs).

**PostgreSQL:** `docker compose exec postgres pg_dump -U codehere codehere > codehere-$(date +%F).sql`

**MySQL:** `docker compose exec mysql sh -c 'mysqldump -ucodehere -p"$MYSQL_PASSWORD" codehere' > codehere-$(date +%F).sql`

Restore by stopping the app, putting the file back (or loading the dump), and starting it again.

## Upgrading

```bash
git pull
# Docker:
docker compose --profile https up -d --build
# systemd:
npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart codehere
```

On shutdown CodeHere saves every open room first, and on startup it applies any new database migrations automatically. People in a room reconnect on their own within a few seconds.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Editor stays on "Connecting…" | The proxy doesn't forward WebSockets. Check the `Upgrade`/`Connection` headers and that `/ws/` reaches CodeHere. |
| `https://admin.example.com` shows the editor or 404 | `ADMIN_HOST` doesn't match the host name exactly, `ADMIN_PASSWORD` is empty, or the proxy rewrites `Host` (set `TRUST_PROXY=true` and send `X-Forwarded-Host`). The startup log says whether admin is enabled. |
| Room links on the admin page point to the wrong domain | Set `PUBLIC_URL=https://code.example.com`. By default it is `ADMIN_HOST` without its first label. |
| Admin sign-in works but you're signed out right away | The cookie is `Secure` over HTTPS; make sure the proxy sends `X-Forwarded-Proto` and `TRUST_PROXY=true`. |
| "Too many connections" / rooms refused | A limit was reached; raise `MAX_CONNECTIONS_PER_IP` / `MAX_NEW_ROOMS_PER_HOUR`, or check that `TRUST_PROXY` is set so all visitors don't share the proxy's IP. |
| Caddy can't get a certificate | DNS doesn't point at the server yet, or ports 80/443 are blocked. |

Health check endpoint for uptime monitors: `GET /healthz` → `ok`.
