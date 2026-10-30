# Running CodeHere on Cloudflare Workers

Besides the Node.js server, CodeHere can run entirely on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [Durable Objects](https://developers.cloudflare.com/durable-objects/). No server to manage, and it fits in the **Workers Free plan**. The public demo at **https://codehere.ayenz.workers.dev** runs this way.

The client is the same. Only the backend in [`cloudflare/`](../cloudflare) differs:

```
codehere.<account>.workers.dev          Worker "codehere"
  ├─ static client (Workers Static Assets)
  ├─ Durable Object "Room"      one per room: the Yjs document, its connections and storage
  └─ Durable Object "Registry"  room list, view-only link index, rate-limit counters

codehere-admin.<account>.workers.dev    Worker "codehere-admin"
  └─ admin page + /api/admin/*  → the same Room/Registry objects through Durable Object bindings
```

Rooms use the WebSocket Hibernation API, so a quiet room costs nothing. Edits are saved to the room's own SQLite storage about a second after people stop typing.

## Node.js server or Cloudflare?

| | Node.js server | Cloudflare Workers |
|---|---|---|
| Hosting | Any VPS or container host | Cloudflare, free plan is enough for small use |
| Database | SQLite, PostgreSQL or MySQL | Durable Object storage (built in) |
| Admin page | `ADMIN_HOST` on the same server | Separate Worker on its own host |
| Admin stats | Rooms, connections, uptime, memory | Rooms and connections |
| Limits | All `MAX_*` settings | Document size, message size, connections per room, new rooms per IP per hour |
| Room expiry | `ROOM_TTL_DAYS` | `ROOM_TTL_DAYS` (Durable Object alarms) |

## Deploy your own

You need a free Cloudflare account and Node.js 22+.

```bash
git clone https://github.com/ayenz/CodeHere.git
cd CodeHere
npm install
npm run build -w client
cd cloudflare
npx wrangler login
```

In `admin.wrangler.jsonc`, change `PUBLIC_URL` to your editor's URL: `https://codehere.<your-subdomain>.workers.dev`, or your custom domain. Then deploy. The editor Worker defines the Durable Objects, so it goes first:

```bash
npx wrangler deploy -c wrangler.jsonc
npx wrangler deploy -c admin.wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD -c admin.wrangler.jsonc   # enter a long random password
```

Wrangler prints both URLs. Without `ADMIN_PASSWORD` the admin page stays disabled.

### Settings

Limits are Worker variables in [`cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc); `0` means unlimited:

| Variable | Default (demo) |
|---|---|
| `MAX_DOC_CHARS` | `100000` |
| `MAX_MESSAGE_BYTES` | `1048576` |
| `MAX_CONNECTIONS_PER_ROOM` | `50` |
| `MAX_NEW_ROOMS_PER_HOUR` | `30` per IP |
| `ROOM_TTL_DAYS` | `7` |

Keep `MAX_DOC_CHARS` and `ROOM_TTL_DAYS` in `admin.wrangler.jsonc` in sync with the editor's values, so the admin page shows the right numbers.

### Custom domain

In the Cloudflare dashboard, open **Workers & Pages → codehere → Settings → Domains & Routes** and add your domain (e.g. `code.example.com`). Do the same for `codehere-admin` (e.g. `admin.example.com`), then update `PUBLIC_URL`.

### Extra protection for the admin page (optional)

Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the admin Worker (free for up to 50 users). In **Workers & Pages → codehere-admin → Settings → Domains & Routes**, enable Cloudflare Access for the `workers.dev` route. Then allow only your email address. Visitors must confirm a one-time code by email before they even see the sign-in form.

## Automatic deploys from GitHub

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) deploys both Workers after every push to `main`, but only when all tests pass, including the end-to-end tests against `wrangler dev`. It needs two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token from the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (`npx wrangler whoami`) |

Secrets such as `ADMIN_PASSWORD` are set once with `wrangler secret put` and kept across deploys.

## Develop and test locally

```bash
npm run build -w client
npm run dev -w cloudflare          # editor on http://127.0.0.1:8787
npm run dev:admin -w cloudflare    # admin on http://127.0.0.1:8788 (in a second terminal)
npm run test:e2e:cloudflare        # the full end-to-end suite against both Workers
```

For the local admin page, put `ADMIN_PASSWORD=…` in `cloudflare/.dev.vars` (git-ignored).

## Free plan budget

At the time of writing, the Workers Free plan allows 100,000 Durable Object requests and 100,000 row writes per day, and 5 GB of storage. Incoming WebSocket messages count 20:1 toward requests. If a daily limit is reached, further operations fail until 00:00 UTC. For heavier use, upgrade to Workers Paid or run the Node.js server instead. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for current numbers.
