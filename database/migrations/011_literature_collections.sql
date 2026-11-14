ALTER TABLE prism.research_references
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE TABLE prism.literature_collections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (user_id, parent_id) REFERENCES prism.literature_collections(user_id, id)
);
CREATE UNIQUE INDEX literature_collection_root_name
  ON prism.literature_collections(user_id, lower(name))
  WHERE deleted_at IS NULL AND parent_id IS NULL;
CREATE UNIQUE INDEX literature_collection_child_name
  ON prism.literature_collections(user_id, parent_id, lower(name))
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL;

CREATE TABLE prism.literature_collection_memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  collection_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, collection_id) REFERENCES prism.literature_collections(user_id, id),
  FOREIGN KEY (user_id, reference_id) REFERENCES prism.research_references(user_id, id)
);
CREATE UNIQUE INDEX literature_membership_collection_reference
  ON prism.literature_collection_memberships(user_id, collection_id, reference_id)
  WHERE deleted_at IS NULL;
CREATE INDEX literature_membership_reference
  ON prism.literature_collection_memberships(user_id, reference_id, collection_id)
  WHERE deleted_at IS NULL;

ALTER TABLE prism.literature_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.literature_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.literature_collections
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.literature_collections
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();

ALTER TABLE prism.literature_collection_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.literature_collection_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.literature_collection_memberships
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.literature_collection_memberships
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
