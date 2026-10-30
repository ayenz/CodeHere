# CodeHere

**A minimal, accessible, real-time collaborative code editor you can host yourself.**
Open a room, share the link, and write code together. No sign-up, no tracking.

**[Try the live demo →](https://codehere.ayenz.workers.dev)** (rooms on the demo are deleted after 7 days without edits)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshot-dark.png">
  <img alt="A CodeHere room: TypeScript code with two other people's cursors, a highlighted linked line, and the toolbar with language, format, download, theme and share buttons." src="docs/images/screenshot-light.png">
</picture>

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Using CodeHere](#using-codehere)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Admin page](#admin-page)
- [How it works](#how-it-works)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

**Collaborate**
- Real-time editing with everyone's cursor and selection in their own colour, built on the [Yjs](https://yjs.dev) CRDT. Edits made offline sync when the connection is back.
- **Edit links** and **view-only links**. View-only is enforced by the server, not just hidden in the UI.
- **Follow** a person: click their avatar and your view tracks their cursor.
- **Links to lines**: click a line number (shift-click for a range) to share `…/room#L10-L20`.
- See who is in the room. Large groups collapse into "+N" with a full list.
- The browser that created a room can **delete** it for everyone.

**Write code**
- [CodeMirror 6](https://codemirror.net) with syntax highlighting for **143 languages**, each loaded only when used.
- **Language auto-detection** for 25 common languages, or pick one for the whole room.
- **Format with Prettier** (<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) for JavaScript, TypeScript, JSX, TSX, JSON, CSS, SCSS, LESS, HTML, Vue, Angular, Markdown and YAML.
- **17 editor themes** (GitHub, VS Code, One Dark, Dracula, Tokyo Night, Nord, Monokai, Solarized, Gruvbox, Material, Xcode…) plus a light/dark app theme.
- Personal settings: font size, indentation (2 or 4 spaces, or tabs), line wrapping, **Vim** and **Emacs** key bindings.
- Search and replace, bracket matching, code folding, multiple cursors, and download as a file.

**Run it**
- One small Node.js server. Choose **SQLite** (default, zero setup), **PostgreSQL** or **MySQL**.
- **Admin page** on its own subdomain: stats, room search, view, lock/unlock and delete rooms.
- Optional limits for public instances (document size, message rate, connections and new rooms per IP…), all off by default.
- Docker image, Docker Compose with automatic HTTPS (Caddy), and a systemd + nginx setup.
- Or run it **serverless on Cloudflare Workers + Durable Objects**, within the free plan. The demo runs this way.
- Light on the wire: about 20–40 bytes per keystroke. About 190 KB of JavaScript and CSS (gzipped) on first load.

**Accessible**
- Semantic landmarks, a skip link and labelled controls throughout.
- Screen readers hear when people join or leave, connection changes and the result of actions.
- Visible focus everywhere, and a keyboard escape from the editor (<kbd>Esc</kbd> then <kbd>Tab</kbd>).
- Colours meet WCAG AA contrast and reduced motion is respected.
- Every change is checked with axe (WCAG 2 A/AA) in CI.

## Quick start

**With Docker:**

```bash
git clone https://github.com/ayenz/CodeHere.git
cd CodeHere
docker compose up -d --build
```

Open http://localhost:3000.

**From source** (Node.js 22 or newer):

```bash
git clone https://github.com/ayenz/CodeHere.git
cd CodeHere
npm install
npm run dev
```

Open http://localhost:5173. Edits reload automatically. To try the admin page, copy `.env.example` to `.env`, set `ADMIN_PASSWORD`, restart, and open http://admin.localhost:5173.

## Using CodeHere

| To… | Do this |
|---|---|
| Start a room | Open the site, or click the **CodeHere** logo. Every room gets its own URL. |
| Invite people to edit | **Share → Edit link → Copy**. Anyone with the link can edit. |
| Let people only watch | **Share → View-only link → Copy**. They see live changes and cursors but cannot type. |
| Point someone at some lines | Click a line number (shift-click to extend), or select lines and use **Share → Point links to the selected lines**. |
| Follow someone | Click their avatar in the top bar. Click it again, press **Stop**, or start typing to stop following. |
| Change the language | Use the language menu. **Auto-detect** guesses from the code; any explicit choice applies to everyone in the room. |
| Format the code | Click the format button or press <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> (shown when the language is supported). |
| Change your name | Click your own avatar (the one with a ring). |
| Theme, font, indentation, Vim/Emacs | Bottom-right corner: the theme menu and the settings button. These only affect you. |
| Delete a room | Use the trash button. It only appears in the browser that created the room. |

**Keyboard shortcuts**

| Shortcut | Action |
|---|---|
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the document |
| <kbd>Esc</kbd> then <kbd>Tab</kbd> | Move focus out of the editor |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Indent / outdent |
| <kbd>Ctrl/Cmd</kbd>+<kbd>F</kbd> | Search and replace |
| <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> / <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo your own changes |
| <kbd>Ctrl/Cmd</kbd>+<kbd>/</kbd> | Toggle comment |
| <kbd>Ctrl/Cmd</kbd>+click | Add a cursor |

## Configuration

All settings are environment variables. Copy `.env.example` to `.env` and adjust it; both `npm run dev`/`npm start` and Docker Compose read it.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` behind a local reverse proxy) |
| `DB_DRIVER` | `sqlite` | `sqlite`, `mysql` or `postgres` |
| `SQLITE_PATH` | `./data/codehere.db` | SQLite file (when `DB_DRIVER=sqlite`) |
| `DATABASE_URL` | — | e.g. `postgres://user:pass@host:5432/codehere` or `mysql://user:pass@host:3306/codehere` |
| `ADMIN_PASSWORD` | — | Admin password. The admin page is off unless this and `ADMIN_HOST` are both set. |
| `ADMIN_HOST` | — | Host name that serves the admin page, e.g. `admin.example.com` (`admin.localhost` in development) |
| `PUBLIC_URL` | derived | Editor URL used for links on the admin page. Defaults to `ADMIN_HOST` without its first label. |
| `TRUST_PROXY` | `false` | Read client IP, host and scheme from `X-Forwarded-*` (only behind your own proxy) |
| `ROOM_TTL_DAYS` | `0` | Delete rooms nobody edited for this many days (`0` keeps them forever) |
| `PERSIST_DEBOUNCE_MS` | `2000` | Delay before saving changes (at most 10 s while people keep typing) |
| `STATIC_DIR` | `client/dist` | Where the built client is served from |

**Limits.** Every limit is off (`0`) by default. Set the ones you need on a public instance; [docs/deployment.md](docs/deployment.md#hardening-a-public-instance) has suggested values.

| Variable | When set |
|---|---|
| `MAX_DOC_CHARS` | Edits that would grow a room beyond this many characters are rejected and reverted for everyone |
| `MAX_MESSAGE_BYTES` | Largest single WebSocket message |
| `MAX_MESSAGES_PER_SECOND` | Sustained messages per connection (bursts up to 4×); going over closes the connection |
| `MAX_CONNECTIONS_PER_IP` | Simultaneous connections per client IP |
| `MAX_NEW_ROOMS_PER_HOUR` | New rooms one IP may create per hour |
| `MAX_ACTIVE_ROOMS` | Rooms held in memory at once |

Docker Compose also uses `PUBLISH` (where the app port is published), `DOMAIN` (for automatic HTTPS) and `DB_PASSWORD` (for the bundled databases). See `.env.example`.

## Deployment

**[docs/deployment.md](docs/deployment.md)** walks through a production setup step by step:

- **Docker Compose + Caddy.** One command, with automatic HTTPS for your domain and admin subdomain:
  ```bash
  docker compose --profile https up -d --build                      # SQLite
  docker compose --profile https --profile postgres up -d --build   # PostgreSQL
  ```
- **Node.js + systemd + nginx**, with ready-made files in [`deploy/`](deploy).
- Using PostgreSQL, MySQL or a managed database.
- Hardening a public instance, what is stored, backups, upgrades and troubleshooting.

**No server at all?** [docs/cloudflare.md](docs/cloudflare.md) shows how to run CodeHere on Cloudflare Workers + Durable Objects, free for small use, with automatic deploys from GitHub.

## Admin page

The admin page has its own host name, so every path on the editor stays free for rooms (even `/admin`).

1. Point DNS for `admin.example.com` at your server.
2. Set `ADMIN_PASSWORD` and `ADMIN_HOST=admin.example.com`.
3. Open `https://admin.example.com` and sign in.

From there you can see live stats (rooms, active rooms, connections, uptime, memory), search rooms by ID, read a room's code, lock a room so nobody can edit it, and delete rooms. Sign-in attempts are rate limited and sessions use an `HttpOnly`, `SameSite=Strict` cookie. The admin API does not exist on any other host.

## How it works

```
Browser (Vite + TypeScript, no framework)
  CodeMirror 6 ── y-codemirror.next ── Y.Doc ── y-websocket provider
                                                   │  y-websocket protocol (binary)
                                                   │  + room status messages
Server (Node.js + ws)                              ▼
  /ws/<room>  /ws/v/<viewId> ──► RoomManager ──► one Y.Doc + Awareness per open room
                                     │
                                     └─ debounced snapshot ──► Kysely ──► SQLite | PostgreSQL | MySQL
  /api/rooms/<id>       creator deletes a room
  ADMIN_HOST            admin page + /api/admin/*
```

- **Sync.** Each room is a Yjs document (`code` text plus a `meta` map for shared settings such as the language). Clients exchange small binary updates through the server, which merges them, so concurrent edits never conflict.
- **Persistence.** A room lives in memory while anyone is connected. Changes are saved as a document snapshot shortly after editing. The room is unloaded when the last person leaves and saved on shutdown. Database migrations run on startup.
- **Permissions.** View-only links (`/v/<viewId>`) and locked rooms are enforced by the server, which drops updates from read-only connections. Viewers never receive the edit link.
- **Ownership.** When you create a room your browser keeps a random secret. The server stores only its SHA-256 and checks it when you delete the room.
- **Presence.** Names, colours and cursors travel over Yjs awareness and are never written to the database.

See [What CodeHere stores](docs/deployment.md#what-codehere-stores) for the full list.

## Development

```
client/           Vite app: editor (index.html, src/) and admin page (admin.html, src/admin/)
server/           Node server: src/ (app, rooms, db, admin, config), test/ (node:test)
cloudflare/       The same backend as Cloudflare Workers + Durable Objects (used by the demo)
e2e/              Playwright end-to-end and accessibility tests
deploy/           Caddyfile, nginx and systemd examples
docs/             Deployment guide and images
```

| Command | What it does |
|---|---|
| `npm run dev` | Server (auto-restart) + Vite dev server on http://localhost:5173 |
| `npm run build` | Build client and server |
| `npm start` | Run the production build on http://localhost:3000 |
| `npm run typecheck` | Type-check both packages |
| `npm test` | Server tests. They use `DB_DRIVER`/`DATABASE_URL`, so the same suite runs against PostgreSQL or MySQL. |
| `npm run test:e2e` | Playwright tests against the production build (run `npm run build` first; set `E2E_BROWSER` to use an installed Chromium-based browser instead of downloading one) |
| `npm run test:e2e:cloudflare` | The same end-to-end tests against the Cloudflare Workers backend (`wrangler dev`) |
| `npm run dev -w cloudflare` | Run the Cloudflare editor Worker locally on http://127.0.0.1:8787 |
| `npm run smoke -w server` | Quick sync and persistence check against a running server |

To run the server tests against PostgreSQL:

```bash
docker run -d --name codehere-pg -e POSTGRES_USER=codehere -e POSTGRES_PASSWORD=codehere -e POSTGRES_DB=codehere -p 5432:5432 postgres:17-alpine
DB_DRIVER=postgres DATABASE_URL=postgres://codehere:codehere@localhost:5432/codehere npm test
```

## Contributing

Issues and pull requests are welcome. CI runs the type check, the server tests against SQLite, PostgreSQL and MySQL, the end-to-end and accessibility tests against both backends (Node.js and Cloudflare Workers), and a Docker build. Pushes to `main` that pass everything are deployed to the demo automatically.

When you change the UI, keep it usable with a keyboard and a screen reader. That means labelling every control, keeping text contrast at WCAG AA or better, and announcing anything that changes without a page load. The axe checks in `e2e/` catch many problems, but not all of them.

## License

[MIT](LICENSE)
