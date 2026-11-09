-- A fixed, one-time updater-capability migration. Future release notices do not reset it.
ALTER TABLE devices ADD COLUMN updater_ready INTEGER NOT NULL DEFAULT 0 CHECK (updater_ready IN (0,1));
