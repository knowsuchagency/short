---
name: short
description: "Create short links on short.52labs.us (a KISS Cloudflare Worker URL shortener). Use when the user wants to shorten a URL, make a short link, generate a vanity/custom short code, or get a tidy share link for a long URL. Triggers: \"shorten this\", \"make a short link\", \"short url\", \"short.52labs.us\", \"vanity link\"."
---

# short — URL shortener (short.52labs.us)

A no-auth Cloudflare Worker that turns long URLs into `https://short.52labs.us/<code>`
links backed by D1 (also reachable at `https://go.52labs.us/<code>`). Anyone can
create links; every create and every click is stored historically and logged to
Workers observability.

## Create a short link

POST JSON to `/api/shorten`. `url` is required; `code` is an optional custom slug.

```bash
# Auto-generated 6-char code
curl -s -X POST https://short.52labs.us/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/very/long/path"}'
# -> {"code":"IFCjsr","short":"https://short.52labs.us/IFCjsr","url":"https://example.com/some/very/long/path"}

# Custom code (vanity link)
curl -s -X POST https://short.52labs.us/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"github.com/anthropics","code":"ant"}'
# -> {"code":"ant","short":"https://short.52labs.us/ant",...}
```

Notes:
- A bare host like `github.com/anthropics` is auto-prefixed with `https://`.
- Custom codes must match `[A-Za-z0-9_-]{1,64}` and not be reserved (`api`, etc.).

## Use a short link

`GET https://short.52labs.us/<code>` issues a `302` redirect to the target URL.

## Responses

| Status | Meaning |
|--------|---------|
| `200`  | Link created — body has `code`, `short`, `url` |
| `400`  | Missing/invalid `url`, or bad custom `code` format |
| `409`  | Custom `code` already taken |
| `302`  | Redirect (on `GET /<code>`) |
| `404`  | Unknown code |

## Returning a link to the user

Give the user the `short` field verbatim (e.g. `https://short.52labs.us/ant`).
For a custom slug, pass `code`; otherwise omit it and let the service generate one.

Source / deploy lives in the `short` repo (`wrangler deploy`).
