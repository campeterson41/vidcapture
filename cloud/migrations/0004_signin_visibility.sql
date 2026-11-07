-- Per-video visibility. Existing and newly shared videos stay public (anyone
-- with the link). Private videos only open for the signed-in owner.
ALTER TABLE videos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
-- One-use sign-in links emailed to the configured owner address.
CREATE TABLE email_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX email_codes_created ON email_codes(created_at);
