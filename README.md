# CodeHere

A minimal, accessible, real-time collaborative code editor. Open a room, share the link, and edit together — no sign-up.

- **Real-time collaboration** with live cursors and selections ([Yjs](https://yjs.dev) CRDT, works offline and resyncs on reconnect)
- **CodeMirror 6** editor with syntax highlighting for 100+ languages (loaded on demand)
- **Shared room settings** — the language is synced for everyone in the room
- **Light / dark / system theme**, download as file, copy link
- **Accessible** — semantic landmarks, skip link, labelled controls, screen-reader announcements for presence and status, visible focus, keyboard escape from the editor (<kbd>Esc</kbd> then <kbd>Tab</kbd>), reduced-motion support
- **Pick your database**: SQLite (default, zero setup), MySQL or PostgreSQL
- Small footprint: one Node process, one WebSocket per tab, ~20–40 bytes per keystroke

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev        # server on :3000, client on http://localhost:5173
```

Production:

```bash
npm run build
npm start          # serves the client and WebSocket on http://localhost:3000
```

Open `/` to create a new room; the URL (`/<room-id>`) is the share link.

## Configuration

Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_DRIVER` | `sqlite` | `sqlite`, `mysql` or `postgres` |
| `SQLITE_PATH` | `./data/codehere.db` | SQLite file (when `DB_DRIVER=sqlite`) |
| `DATABASE_URL` | — | e.g. `mysql://user:pass@host:3306/codehere` or `postgres://user:pass@host:5432/codehere` |
| `ROOM_TTL_DAYS` | `30` | Delete rooms not edited for this many days (`0` = never) |
| `PERSIST_DEBOUNCE_MS` | `2000` | Delay before writing changes to the database (at most 10 s while editing) |
| `STATIC_DIR` | `client/dist` | Where the built client is served from |

The schema is created automatically on startup (Kysely migrations).

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

## Architecture

```
client/  Vite + TypeScript (no framework)
  CodeMirror 6 ── y-codemirror.next ── Y.Doc ── y-websocket provider
                                                    │ binary y-websocket protocol
server/  Node + ws                                  ▼
  /ws/:room ── RoomManager ── Y.Doc + Awareness per room (in memory)
                     └── debounced snapshot ──► Kysely ──► SQLite | MySQL | PostgreSQL
```

- Each room is one `Y.Doc`: text in `getText('code')`, shared settings in `getMap('meta')`.
- The server speaks the standard y-websocket sync/awareness protocol, keeps a room in memory while anyone is connected, saves a snapshot after edits, and unloads the room when the last person leaves.
- Presence (names, colours, cursors) uses Yjs awareness and is never stored.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite dev server |
| `npm run build` | Build client and server |
| `npm start` | Run the production server |
| `npm run typecheck` | Type-check both packages |
| `npm run smoke -w server` | End-to-end sync/persistence check against a running server |

## Contributing

Issues and pull requests are welcome. Please keep the UI keyboard- and screen-reader-friendly: label every control, keep text contrast at WCAG AA or better, and test with the keyboard only.

## License

[MIT](LICENSE)
