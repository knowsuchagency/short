/**
 * short — a KISS URL shortener on Cloudflare Workers.
 *
 * Routes:
 *   GET  /              landing page with a create form
 *   GET  /privacy       privacy policy
 *   POST /api/shorten   { url, code? } -> { code, short, url }
 *   GET  /:code         302 redirect to the stored URL (records the click)
 *
 * Storage is a single D1 database (binding DB, see schema.sql):
 *   links  — one row per short link
 *   clicks — one historical row per redirect served (never deleted)
 *
 * No auth. Every create/click is also emitted as a structured console.log line
 * that flows to Workers observability / logpush.
 */

// Env (with the DB D1 binding) comes from the generated
// worker-configuration.d.ts — regenerate with `wrangler types`.

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Paths that can never be used as a short code (they belong to the app).
const RESERVED = new Set(["", "api", "privacy", "favicon.ico", "robots.txt"]);

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

async function codeExists(env: Env, code: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM links WHERE code = ?").bind(code).first();
  return row !== null;
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

  // Custom code: validate characters and avoid reserved/colliding codes.
  if (code) {
    code = code.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      return json({ error: "Custom code may only contain letters, numbers, - and _." }, 400);
    }
    if (RESERVED.has(code)) return json({ error: "That code is reserved." }, 400);
    if (await codeExists(env, code)) return json({ error: "That code is already taken." }, 409);
  } else {
    // Auto-generate, retrying on the (astronomically unlikely) collision.
    for (let i = 0; i < 5; i++) {
      const candidate = randomCode();
      if (!(await codeExists(env, candidate))) {
        code = candidate;
        break;
      }
    }
    if (!code) return json({ error: "Could not allocate a code, try again." }, 500);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO links (code, url, created_at, created_ip, created_country) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        code,
        target,
        Date.now(),
        req.headers.get("cf-connecting-ip"),
        (req as any).cf?.country ?? null,
      )
      .run();
  } catch {
    // UNIQUE violation from a race between the existence check and the insert.
    return json({ error: "That code is already taken." }, 409);
  }

  console.log(JSON.stringify({ event: "create", code, url: target }));
  return json({ code, short: `${origin}/${code}`, url: target });
}

async function redirect(code: string, env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const row = await env.DB.prepare("SELECT url FROM links WHERE code = ?")
    .bind(code)
    .first<{ url: string }>();

  if (!row) {
    console.log(JSON.stringify({ event: "miss", code }));
    return new Response("Not found", { status: 404 });
  }

  const target = row.url;
  const referer = req.headers.get("referer");
  const ua = req.headers.get("user-agent");
  const country = (req as any).cf?.country ?? null;
  const ip = req.headers.get("cf-connecting-ip");

  console.log(JSON.stringify({ event: "click", code, url: target, referer, ua, country }));

  // Record the click historically without blocking the redirect.
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO clicks (code, url, ts, referer, ua, country, ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(code, target, Date.now(), referer, ua, country, ip)
      .run()
      .catch((e: unknown) => console.log(JSON.stringify({ event: "click_log_error", code, error: String(e) }))),
  );

  return Response.redirect(target, 302);
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  p.sub { color: #888; margin-top: 0; }
  form { display: flex; flex-direction: column; gap: .75rem; margin-top: 2rem; }
  input { padding: .7rem .8rem; font-size: 1rem; border: 1px solid #8884; border-radius: .5rem; background: transparent; color: inherit; }
  button { padding: .7rem; font-size: 1rem; border: 0; border-radius: .5rem; background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  #out { margin-top: 1.5rem; word-break: break-all; }
  #out a { font-size: 1.1rem; }
  .err { color: #dc2626; }
  footer { margin-top: 3rem; font-size: .85rem; color: #888; }
  footer a { color: inherit; }
  a { color: #2563eb; }
`;

function html(body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>short</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function landingPage(): Response {
  return html(`
  <h1>short</h1>
  <p class="sub">Paste a URL, get a short link.</p>
  <form id="f">
    <input id="url" name="url" type="text" placeholder="https://example.com/very/long/link" required autofocus>
    <input id="code" name="code" type="text" placeholder="custom code (optional)">
    <button type="submit">Shorten</button>
  </form>
  <div id="out"></div>
  <footer>By shortening a link you agree to our <a href="/privacy">privacy policy</a>.</footer>
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
</script>`);
}

function privacyPage(): Response {
  return html(`
  <h1>Privacy Policy</h1>
  <p class="sub">Last updated June 3, 2026</p>

  <p><strong>short</strong> is a free URL shortening service. This policy explains
  what we collect and how we use it. By using the service you agree to these terms.</p>

  <h2>What we collect</h2>
  <p>When you create a link, we store the destination URL, the short code, and
  metadata about the request — including the time, approximate location (country),
  and IP address. When someone follows a link, we record each visit along with
  similar metadata (time, referring page, browser user-agent, country, and IP).
  We retain this information indefinitely as part of the service's history.</p>

  <h2>How we use it</h2>
  <p>We use the data we collect to operate, maintain, analyze, and improve the
  service, to understand usage and traffic patterns, to keep the service secure
  and prevent abuse, and for other legitimate business purposes. We may aggregate
  or analyze the data and may use it to develop new features and offerings. In
  short, information submitted to or generated by the service may be used at our
  discretion in connection with operating and improving it.</p>

  <h2>Sharing</h2>
  <p>We may share data with service providers who help us run the platform, and
  where required by law or to protect the service. We do not sell your personal
  information.</p>

  <h2>No warranty</h2>
  <p>The service is provided “as is,” free of charge, without warranties of any
  kind. Don't shorten links containing sensitive or confidential information.</p>

  <h2>Contact</h2>
  <p>Questions? Reach us at <a href="mailto:hello@52labs.us">hello@52labs.us</a>.</p>

  <footer><a href="/">← back</a></footer>`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.slice(1); // drop leading '/'

    if (req.method === "GET" && path === "") return landingPage();
    if (req.method === "GET" && path === "privacy") return privacyPage();

    if (path === "api/shorten") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      return createLink(req, env, url.origin);
    }

    if (path === "favicon.ico" || path === "robots.txt") {
      return new Response(null, { status: 204 });
    }

    if (req.method === "GET" && !path.includes("/")) {
      return redirect(path, env, req, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
