/**
 * short — a KISS URL shortener on Cloudflare Workers.
 *
 * Routes:
 *   GET  /              landing page with a create form
 *   POST /api/shorten   { url, code? } -> { code, short, url }
 *   GET  /:code         302 redirect to the stored URL (logs the click)
 *
 * Storage is a single KV namespace (LINKS): key = code, value = target URL.
 * No auth, no database — just KV and structured console logging that flows
 * to Workers observability / logpush.
 */

// Env (with the LINKS KV binding) comes from the generated
// worker-configuration.d.ts — regenerate with `wrangler types`.

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Paths that can never be used as a short code (they belong to the app).
const RESERVED = new Set(["", "api", "favicon.ico", "robots.txt"]);

function randomCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Default to https:// when the user omits a scheme.
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function createLink(req: Request, env: Env, origin: string): Promise<Response> {
  let url: string | undefined;
  let code: string | undefined;

  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    url = typeof body.url === "string" ? body.url : undefined;
    code = typeof body.code === "string" ? body.code : undefined;
  } else {
    const form = await req.formData();
    url = (form.get("url") as string) || undefined;
    code = (form.get("code") as string) || undefined;
  }

  const target = url ? normalizeUrl(url) : null;
  if (!target) return json({ error: "Provide a valid url." }, 400);

  // Custom code: validate characters and avoid reserved/colliding keys.
  if (code) {
    code = code.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      return json({ error: "Custom code may only contain letters, numbers, - and _." }, 400);
    }
    if (RESERVED.has(code)) return json({ error: "That code is reserved." }, 400);
    if (await env.LINKS.get(code)) return json({ error: "That code is already taken." }, 409);
  } else {
    // Auto-generate, retrying on the (astronomically unlikely) collision.
    for (let i = 0; i < 5; i++) {
      const candidate = randomCode();
      if (!(await env.LINKS.get(candidate))) {
        code = candidate;
        break;
      }
    }
    if (!code) return json({ error: "Could not allocate a code, try again." }, 500);
  }

  await env.LINKS.put(code, target);
  console.log(JSON.stringify({ event: "create", code, url: target }));
  return json({ code, short: `${origin}/${code}`, url: target });
}

async function redirect(code: string, env: Env, req: Request): Promise<Response> {
  const target = await env.LINKS.get(code);
  if (!target) {
    console.log(JSON.stringify({ event: "miss", code }));
    return new Response("Not found", { status: 404 });
  }
  console.log(
    JSON.stringify({
      event: "click",
      code,
      url: target,
      referer: req.headers.get("referer") || null,
      ua: req.headers.get("user-agent") || null,
      country: (req as any).cf?.country ?? null,
    }),
  );
  return Response.redirect(target, 302);
}

function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>short</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  p.sub { color: #888; margin-top: 0; }
  form { display: flex; flex-direction: column; gap: .75rem; margin-top: 2rem; }
  input { padding: .7rem .8rem; font-size: 1rem; border: 1px solid #8884; border-radius: .5rem; background: transparent; color: inherit; }
  button { padding: .7rem; font-size: 1rem; border: 0; border-radius: .5rem; background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  #out { margin-top: 1.5rem; word-break: break-all; }
  #out a { font-size: 1.1rem; }
  .err { color: #dc2626; }
</style>
</head>
<body>
  <h1>short</h1>
  <p class="sub">Paste a URL, get a short link.</p>
  <form id="f">
    <input id="url" name="url" type="text" placeholder="https://example.com/very/long/link" required autofocus>
    <input id="code" name="code" type="text" placeholder="custom code (optional)">
    <button type="submit">Shorten</button>
  </form>
  <div id="out"></div>
<script>
const f = document.getElementById('f');
const out = document.getElementById('out');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  out.textContent = '…';
  const res = await fetch('/api/shorten', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: document.getElementById('url').value, code: document.getElementById('code').value || undefined }),
  });
  const data = await res.json();
  if (!res.ok) { out.innerHTML = '<span class="err">' + (data.error || 'Error') + '</span>'; return; }
  out.innerHTML = '<a href="' + data.short + '">' + data.short + '</a>';
  navigator.clipboard?.writeText(data.short).catch(() => {});
});
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.slice(1); // drop leading '/'

    if (path === "" && req.method === "GET") return landingPage();

    if (path === "api/shorten") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      return createLink(req, env, url.origin);
    }

    if (path === "favicon.ico" || path === "robots.txt") {
      return new Response(null, { status: 204 });
    }

    if (req.method === "GET" && !path.includes("/")) {
      return redirect(path, env, req);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
