# CodeHere

A minimal, accessible, real-time collaborative code editor. Open a room, share the link, and edit together — no sign-up.

**Collaboration**
- Real-time editing with live cursors and selections ([Yjs](https://yjs.dev) CRDT; works offline and resyncs on reconnect)
- Edit links and **view-only links** (people can read along but not edit, enforced by the server)
- **Follow** someone's cursor by clicking their avatar
- **Links to lines**: click a line number (shift-click for a range) to get `…/room#L10-L20`
- The browser that created a room can **delete** it

**Editor**
- CodeMirror 6 with syntax highlighting for 100+ languages, loaded on demand, and **language auto-detection**
- **Format** with Prettier (JS/TS/JSX/TSX, JSON, CSS/SCSS/LESS, HTML, Vue, Angular, Markdown, YAML) — <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>
- 17 editor themes plus light/dark app theme, font size, indentation, line wrapping, **Vim** and **Emacs** key bindings
- Download the code as a file

**Operations**
- **Admin page** on its own subdomain (e.g. `admin.example.com`): stats, search rooms, view, lock/unlock and delete rooms. Every path on the main domain stays available for rooms — even `/admin`.
- Pick your database: **SQLite** (default, zero setup), **MySQL** or **PostgreSQL**
- Optional limits: document size, message size and rate, connections per IP, new rooms per hour — all off by default
- One Node process, one WebSocket per tab, ~20–40 bytes per keystroke

**Accessibility** — semantic landmarks, skip link, labelled controls, screen-reader announcements for presence, status and actions, visible focus, keyboard escape from the editor (<kbd>Esc</kbd> then <kbd>Tab</kbd>), reduced-motion support, and automated axe checks (WCAG 2 AA) in CI.

## Quick start

Requires Node.js 22+.

```bash
npm install
npm run dev        # server on :3000, client on http://localhost:5173
```

Production:

```bash
npm run build
npm start          # serves the client, admin page and WebSocket on http://localhost:3000
```

Open `/` to create a new room; the URL (`/<room-id>`) is the edit link. The **Share** button also gives you a view-only link (`/v/<view-id>`).

## Configuration

Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_DRIVER` | `sqlite` | `sqlite`, `mysql` or `postgres` |
| `SQLITE_PATH` | `./data/codehere.db` | SQLite file (when `DB_DRIVER=sqlite`) |
| `DATABASE_URL` | — | e.g. `mysql://user:pass@host:3306/codehere` or `postgres://user:pass@host:5432/codehere` |
| `ADMIN_PASSWORD` | — | Admin password. The admin page is disabled unless this and `ADMIN_HOST` are set. |
| `ADMIN_HOST` | — | Host that serves the admin page and API, e.g. `admin.example.com` (`admin.localhost` in development) |
| `PUBLIC_URL` | derived | Editor URL for links from the admin page, e.g. `https://example.com`. Defaults to `ADMIN_HOST` without its first label. |
| `TRUST_PROXY` | `false` | Read client IPs from `X-Forwarded-For` (only behind your own reverse proxy) |
| `ROOM_TTL_DAYS` | `0` | Delete rooms not edited for this many days (`0` = keep forever) |
| `PERSIST_DEBOUNCE_MS` | `2000` | Delay before writing changes to the database (at most 10 s while editing) |
| `STATIC_DIR` | `client/dist` | Where the built client is served from |

### Limits

Every limit is **off (`0`) by default**. Set the ones you need for a public instance.

| Variable | Effect when set |
|---|---|
| `MAX_DOC_CHARS` | Edits that would grow a room past this many characters are rejected (and reverted for everyone) |
| `MAX_MESSAGE_BYTES` | Largest single WebSocket message |
| `MAX_MESSAGES_PER_SECOND` | Sustained messages per connection (bursts up to 4×); excess closes the connection |
| `MAX_CONNECTIONS_PER_IP` | Simultaneous connections per client IP |
| `MAX_NEW_ROOMS_PER_HOUR` | New rooms a client IP may create per hour |
| `MAX_ACTIVE_ROOMS` | Rooms kept in memory at once |

The schema is created and migrated automatically on startup.

## Docker

```bash
docker compose up -d --build                     # SQLite in a volume

# PostgreSQL
DB_DRIVER=postgres DATABASE_URL=postgres://codehere:codehere@postgres:5432/codehere \
  docker compose --profile postgres up -d --build

# MySQL
DB_DRIVER=mysql DATABASE_URL=mysql://codehere:codehere@mysql:3306/codehere \
  docker compose --profile mysql up -d --build
```

Add `ADMIN_PASSWORD=…` and `ADMIN_HOST=admin.example.com` to enable the admin page. The image runs as a non-root user and stores SQLite data in `/data`.

## Admin page

The admin page lives on its own host so that no room name is reserved for it:

1. Point DNS for `admin.example.com` at the same server as `example.com`.
2. Set `ADMIN_PASSWORD` and `ADMIN_HOST=admin.example.com`.
3. Make your reverse proxy forward both hosts to CodeHere, keeping the `Host` header (or send `X-Forwarded-Host` with `TRUST_PROXY=true`). For example, with Caddy:

   ```
   example.com, admin.example.com {
     reverse_proxy localhost:3000
   }
   ```

The admin API only answers on `ADMIN_HOST`, and the admin host serves nothing but the admin page. In development, open `http://admin.localhost:5173` (`*.localhost` resolves to your machine in Chrome and Firefox).

## Architecture

```
client/  Vite + TypeScript (no framework)
  CodeMirror 6 ── y-codemirror.next ── Y.Doc ── y-websocket provider
                                                    │ binary y-websocket protocol
server/  Node + ws                                  ▼        + status messages (type 100)
  /ws/:room, /ws/v/:viewId ── RoomManager ── Y.Doc + Awareness per room (in memory)
                     └── debounced snapshot ──► Kysely ──► SQLite | MySQL | PostgreSQL
  /api/rooms/:id (owner delete) · ADMIN_HOST: admin page + /api/admin/*
```

- Each room is one `Y.Doc`: text in `getText('code')`, shared settings in `getMap('meta')`.
- The server speaks the standard y-websocket sync/awareness protocol, keeps a room in memory while anyone is connected, saves a snapshot after edits, and unloads the room when the last person leaves.
- Read-only access (view links, locked rooms) is enforced on the server: updates from read-only connections are dropped.
- Presence (names, colours, cursors) uses Yjs awareness and is never stored.
- Room ownership is a random token kept in the creator's browser; the server stores only its SHA-256.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite dev server |
| `npm run build` | Build client and server |
| `npm start` | Run the production server |
| `npm run typecheck` | Type-check both packages |
| `npm test` | Server test suite (uses `DB_DRIVER`/`DATABASE_URL`, SQLite by default) |
| `npm run test:e2e` | Playwright end-to-end and accessibility tests (run `npm run build` first; set `E2E_BROWSER` to use an installed Chromium-based browser) |
| `npm run smoke -w server` | Quick sync/persistence check against a running server |

## Contributing

Issues and pull requests are welcome. CI runs the type check, the server tests against SQLite, MySQL and PostgreSQL, the end-to-end tests and a Docker build. Please keep the UI keyboard- and screen-reader-friendly: label every control, keep text contrast at WCAG AA or better, and test with the keyboard only.

## License

[MIT](LICENSE)
