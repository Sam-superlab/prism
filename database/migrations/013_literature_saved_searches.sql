CREATE TABLE prism.literature_saved_searches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  query text NOT NULL DEFAULT '' CHECK (length(query) <= 300),
  tag text NOT NULL DEFAULT '' CHECK (length(tag) <= 64),
  collection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, collection_id) REFERENCES prism.literature_collections(user_id, id)
);

CREATE UNIQUE INDEX literature_saved_search_name
  ON prism.literature_saved_searches(user_id, lower(name))
  WHERE deleted_at IS NULL;
ALTER TABLE prism.literature_saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.literature_saved_searches FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.literature_saved_searches
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.literature_saved_searches
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
