-- Captions uploaded from the desktop app (WebVTT next to the video in R2).
ALTER TABLE videos ADD COLUMN captions INTEGER NOT NULL DEFAULT 0;
-- Owners get an email when someone comments, at most one per video every 15 minutes.
ALTER TABLE accounts ADD COLUMN notify_comments INTEGER NOT NULL DEFAULT 1;
-- Emoji reactions at a moment in the video. No identity is stored.
CREATE TABLE reactions (video_id TEXT NOT NULL REFERENCES videos(id), emoji TEXT NOT NULL, at_seconds REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX reactions_video ON reactions(video_id);
