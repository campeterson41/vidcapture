-- Viewer comments on shared videos, optionally pinned to a moment (at_seconds).
-- Replies point at a top-level comment. Guests have no account; they keep a
-- private key (only its hash is stored here) that lets them delete their own comment.
CREATE TABLE comments (
 id TEXT PRIMARY KEY,
 video_id TEXT NOT NULL REFERENCES videos(id),
 parent_id TEXT REFERENCES comments(id),
 account_id TEXT REFERENCES accounts(id),
 author_name TEXT NOT NULL,
 body TEXT NOT NULL,
 at_seconds REAL,
 key_hash TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX comments_video ON comments(video_id, created_at);
CREATE INDEX comments_account ON comments(account_id);
ALTER TABLE videos ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 1;
