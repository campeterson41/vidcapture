-- One counted play per visitor per video per window. mark_hash is
-- SHA-256(video id, visitor IP); the raw IP is never stored.
CREATE TABLE view_marks (mark_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX view_marks_expires ON view_marks(expires_at);
