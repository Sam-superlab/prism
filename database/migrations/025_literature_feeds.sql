CREATE TABLE prism.literature_feeds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  custom_title boolean NOT NULL DEFAULT false,
  last_refreshed_at timestamptz,
  last_refresh_error text CHECK (length(last_refresh_error) <= 500),
  refresh_token uuid,
  refresh_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  CHECK ((refresh_token IS NULL) = (refresh_started_at IS NULL))
);

CREATE UNIQUE INDEX literature_feeds_active_url
  ON prism.literature_feeds(user_id, url) WHERE deleted_at IS NULL;
ALTER TABLE prism.literature_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.literature_feeds FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.literature_feeds
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.literature_feeds
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();

CREATE TABLE prism.literature_feed_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  feed_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  url text CHECK (length(url) <= 2000),
  authors text[] NOT NULL CHECK (cardinality(authors) <= 30),
  published_at timestamptz,
  summary text CHECK (length(summary) <= 4000),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (user_id, feed_id) REFERENCES prism.literature_feeds(user_id, id),
  UNIQUE (user_id, feed_id, external_id)
);

CREATE INDEX literature_feed_entries_recent
  ON prism.literature_feed_entries(user_id, feed_id, (coalesce(published_at,created_at)) DESC, id DESC);
ALTER TABLE prism.literature_feed_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.literature_feed_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.literature_feed_entries
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
