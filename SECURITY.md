# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/ayenz/CodeHere/security/advisories/new)
with steps to reproduce and the impact you expect. You should get an answer within a week.
Please give us a reasonable time to release a fix before you disclose anything publicly.

## Security model

CodeHere has no user accounts. Access works through links:

- **Edit link** (`/<room>`): anyone who has it can read and change the room.
- **View-only link** (`/v/<id>`): anyone who has it can read along. The server drops every change from these connections, and a view link never reveals the edit link.
- **Room creator**: the browser that created a room keeps a random secret that allows deleting it. The server stores only its SHA-256 hash.
- **Admin page**: lives only on its own host (`ADMIN_HOST`). It needs a password, uses an `HttpOnly`, `SameSite=Strict` session cookie, and limits sign-in attempts.

Room names chosen by hand (e.g. `/team-standup`) are as guessable as the name. Generated room IDs and view IDs are random.

## What the server enforces

- **Document content.** Clients may only add plain text to the code and a short language name to the room settings. Updates that write anything else are rejected and the connection is closed. This stops clients from storing hidden data or bypassing `MAX_DOC_CHARS`.
- **Presence data.**
  - Names are length-limited and colours must be `#rrggbb`, because both end up in other people's CSS.
  - Unknown fields are removed, and the server, not the client, decides whether a person is a viewer.
  - A connection can't overwrite or remove someone else's cursor.
- **HTTP.** Every response carries a strict Content-Security-Policy:
  - scripts from the same origin only, no inline scripts;
  - `frame-ancestors 'none'`;
  - `X-Content-Type-Options`, `Referrer-Policy` and related headers.
- **Malformed requests** are answered with 400 and never crash the server.

## Hardening a public instance

All limits are off by default. On an instance anyone can reach, follow
[docs/deployment.md → Hardening a public instance](docs/deployment.md#hardening-a-public-instance):
set the `MAX_*` limits, keep the app port private behind your reverse proxy, and use long random admin secrets.
