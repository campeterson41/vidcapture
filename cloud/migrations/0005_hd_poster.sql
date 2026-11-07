-- 1 when the stored poster is 1280x720. Older posters are 640x400 and are
-- replaced from the library so link previews show as large cards.
ALTER TABLE videos ADD COLUMN poster_hd INTEGER NOT NULL DEFAULT 0;
