-- short — D1 schema.
-- Apply locally:  wrangler d1 execute short --local  --file=schema.sql
-- Apply remote:   wrangler d1 execute short --remote --file=schema.sql

-- One row per short link.
CREATE TABLE IF NOT EXISTS links (
  code       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL,      -- unix epoch ms
  created_ip TEXT,
  created_country TEXT
);

-- Historical click log — one row per redirect served. Never deleted, so we keep
-- the full history of every link's traffic.
CREATE TABLE IF NOT EXISTS clicks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL,
  url      TEXT NOT NULL,           -- target at click time (denormalized snapshot)
  ts       INTEGER NOT NULL,        -- unix epoch ms
  referer  TEXT,
  ua       TEXT,
  country  TEXT,
  ip       TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks (code);
CREATE INDEX IF NOT EXISTS idx_clicks_ts   ON clicks (ts);
