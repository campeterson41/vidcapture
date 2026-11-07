-- Public accounts. Every device and video belongs to an account; browser
-- sessions belong to accounts instead of devices.
CREATE TABLE accounts (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT,
 created_at INTEGER NOT NULL,
 verified_at INTEGER,
 quota_bytes INTEGER NOT NULL DEFAULT 5368709120,
 is_admin INTEGER NOT NULL DEFAULT 0,
 disabled INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE devices ADD COLUMN account_id TEXT REFERENCES accounts(id);
-- The website's own upload device. No token exists for it; it is never listed or paired.
ALTER TABLE devices ADD COLUMN website INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN account_id TEXT REFERENCES accounts(id);
CREATE INDEX videos_account ON videos(account_id, created_at DESC);
CREATE INDEX devices_account ON devices(account_id);
CREATE TABLE account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL);
CREATE INDEX account_sessions_account ON account_sessions(account_id);
-- One-use emailed tokens: verify (confirm address), reset (password), signin (link).
CREATE TABLE account_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), purpose TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- Desktop app connection requests. The app keeps its device token; only its hash is here.
CREATE TABLE pairings (id TEXT PRIMARY KEY, device_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, code TEXT NOT NULL, account_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE reports (id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), reason TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
CREATE INDEX reports_open ON reports(resolved, created_at DESC);
-- Sliding-window rate limits. Keys hold hashes, never raw addresses or IPs.
CREATE TABLE rate_events (key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX rate_events_key ON rate_events(key, at);
