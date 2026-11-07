CREATE TABLE devices (token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL REFERENCES devices(token_hash), expires_at INTEGER NOT NULL);
CREATE TABLE login_codes (code_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL REFERENCES devices(token_hash), expires_at INTEGER NOT NULL);
CREATE TABLE videos (
 id TEXT PRIMARY KEY, share_id TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
 object_key TEXT UNIQUE NOT NULL, upload_id TEXT, status TEXT NOT NULL DEFAULT 'uploading',
 size INTEGER NOT NULL, duration REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
 created_at INTEGER NOT NULL, published_at INTEGER, views INTEGER NOT NULL DEFAULT 0,
 device_hash TEXT NOT NULL REFERENCES devices(token_hash)
);
CREATE TABLE parts (video_id TEXT NOT NULL REFERENCES videos(id), part_number INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(video_id,part_number));
CREATE INDEX videos_created ON videos(created_at DESC);
CREATE INDEX sessions_expires ON sessions(expires_at);
