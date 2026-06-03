# short

A KISS URL shortener running as a Cloudflare Worker at **https://short.52labs.us**
(also **https://go.52labs.us**).

No auth — just a D1 database and structured logging.

## How it works

- `GET /` — landing page with a form to create short links
- `GET /privacy` — privacy policy
- `POST /api/shorten` — `{ "url": "...", "code": "optional-custom" }` → `{ code, short, url }`
- `GET /:code` — `302` redirect to the stored URL (records the click)

Data lives in a **D1** database (binding `DB`, schema in `schema.sql`):

- `links` — one row per short link (`code`, `url`, `created_at`, ip/country).
- `clicks` — one **historical** row per redirect served (time, referer, ua,
  country, ip). Never deleted, so the full traffic history is retained.

Codes are random 6-char base62, or a custom code you supply.

## Logging

Every create / click / miss is also emitted as a structured `console.log` JSON
line. Workers observability is enabled and `logpush` is on, so events flow to the
Cloudflare dashboard (Workers → short → Logs) and any configured logpush sink.

```bash
wrangler tail                                   # live logs
wrangler d1 execute short --remote --command \
  "SELECT code, COUNT(*) FROM clicks GROUP BY code ORDER BY 2 DESC"   # click counts
```

## Develop & deploy

```bash
bun install
wrangler d1 execute short --local  --file=schema.sql   # init local DB
wrangler d1 execute short --remote --file=schema.sql   # init remote DB (idempotent)
bun run dev      # local dev (wrangler dev)
bun run deploy   # wrangler deploy
```

After editing `wrangler.jsonc`, regenerate types with `wrangler types`.

## Config notes

- `short.52labs.us` and `go.52labs.us` attach as Cloudflare **custom domains**
  (Cloudflare manages each DNS record). Other records on `52labs.us` are untouched.
- The D1 database id is pinned in `wrangler.jsonc`.
