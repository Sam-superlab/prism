ALTER TABLE prism.literature_feeds
  ADD COLUMN auto_refresh boolean NOT NULL DEFAULT false,
  ADD COLUMN next_refresh_at timestamptz,
  ADD COLUMN refresh_failures integer NOT NULL DEFAULT 0 CHECK (refresh_failures BETWEEN 0 AND 6),
  ADD COLUMN refresh_scheduled boolean NOT NULL DEFAULT false,
  ADD COLUMN scheduled_refresh_started_at timestamptz,
  ADD CONSTRAINT literature_feed_schedule_shape CHECK (auto_refresh = (next_refresh_at IS NOT NULL)),
  ADD CONSTRAINT literature_feed_scheduled_claim CHECK (NOT refresh_scheduled OR (auto_refresh AND refresh_token IS NOT NULL));

CREATE INDEX literature_feeds_due
  ON prism.literature_feeds(user_id, next_refresh_at, id)
  WHERE auto_refresh AND deleted_at IS NULL;
CREATE INDEX literature_feeds_recent_schedule
  ON prism.literature_feeds(user_id, scheduled_refresh_started_at DESC)
  WHERE scheduled_refresh_started_at IS NOT NULL;
