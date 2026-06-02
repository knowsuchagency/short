# short

A KISS URL shortener running as a Cloudflare Worker at **https://short.52labs.us**.

No database, no auth — just a single KV namespace and structured logging.

## How it works

- `GET /` — landing page with a form to create short links
- `POST /api/shorten` — `{ "url": "...", "code": "optional-custom" }` → `{ code, short, url }`
- `GET /:code` — `302` redirect to the stored URL (logs the click)

URLs live in the `LINKS` KV namespace (key = code, value = target URL). Codes
are random 6-char base62, or a custom code you supply.

## Logging

Every create / click / miss is emitted as a structured `console.log` JSON line.
Workers observability is enabled and `logpush` is on, so events flow to the
Cloudflare dashboard (Workers → short → Logs) and any configured logpush sink.

Tail live:

```bash
wrangler tail
```

## Develop & deploy

```bash
bun install
bun run dev      # local dev (wrangler dev)
bun run deploy   # wrangler deploy
```

After editing `wrangler.jsonc`, regenerate types with `wrangler types`.

## Config notes

- `short.52labs.us` is attached as a Cloudflare **custom domain** (Cloudflare
  manages the DNS record). Other records on `52labs.us` are untouched.
- KV namespace id is pinned in `wrangler.jsonc`.
