CREATE TABLE prism.team_account_profiles (
  user_id uuid PRIMARY KEY REFERENCES prism.users(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200)
);

CREATE TABLE prism.team_libraries (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=2000),
  created_by uuid NOT NULL REFERENCES prism.users(id),
  updated_by uuid NOT NULL REFERENCES prism.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  deleted_at timestamptz
);

CREATE TABLE prism.team_library_members (
  library_id uuid NOT NULL REFERENCES prism.team_libraries(id),
  user_id uuid NOT NULL REFERENCES prism.users(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('admin','editor','reader')),
  added_by uuid NOT NULL REFERENCES prism.users(id),
  updated_by uuid NOT NULL REFERENCES prism.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  deleted_at timestamptz,
  PRIMARY KEY (library_id,user_id)
);

CREATE INDEX team_library_members_account ON prism.team_library_members(user_id,library_id) WHERE deleted_at IS NULL;

CREATE TABLE prism.team_library_references (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES prism.team_libraries(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  authors text[] NOT NULL DEFAULT '{}' CHECK (cardinality(authors)<=100),
  year integer CHECK (year BETWEEN 1 AND 9999),
  doi text CHECK (length(doi)<=250),
  url text CHECK (length(url)<=2000),
  publication jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(publication)='object'),
  created_by uuid NOT NULL REFERENCES prism.users(id),
  updated_by uuid NOT NULL REFERENCES prism.users(id),
  created_by_name text NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 200),
  updated_by_name text NOT NULL CHECK (length(updated_by_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  deleted_at timestamptz
);

CREATE INDEX team_library_references_recent ON prism.team_library_references(library_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;

CREATE TABLE prism.team_library_events (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES prism.team_libraries(id),
  actor_id uuid NOT NULL REFERENCES prism.users(id),
  action text NOT NULL CHECK (action IN ('library_created','library_updated','library_deleted','member_added','member_updated','member_removed','reference_created','reference_updated','reference_deleted')),
  subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- These narrowly scoped helpers use migration ownership to avoid recursive team policies.
-- Ordinary runtime roles are nonowners. Existing personal-table policies are unchanged.
CREATE FUNCTION prism.team_library_role(library uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
  SELECT CASE WHEN t.created_by=prism.principal() THEN 'admin' ELSE m.role END
  FROM prism.team_libraries t LEFT JOIN prism.team_library_members m
    ON m.library_id=t.id AND m.user_id=prism.principal() AND m.deleted_at IS NULL
  WHERE t.id=library AND t.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION prism.team_library_role(uuid) FROM PUBLIC;

CREATE FUNCTION prism.team_library_account_name(library uuid, account uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
  SELECT p.display_name FROM prism.team_account_profiles p
  WHERE p.user_id=account AND (account=prism.principal() OR prism.team_library_role(library)='admin')
$$;
REVOKE ALL ON FUNCTION prism.team_library_account_name(uuid,uuid) FROM PUBLIC;

ALTER TABLE prism.team_account_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_profile_owner ON prism.team_account_profiles
  USING (user_id=prism.principal()) WITH CHECK (user_id=prism.principal());

ALTER TABLE prism.team_libraries ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_library_read ON prism.team_libraries FOR SELECT
  USING (created_by=prism.principal() OR prism.team_library_role(id) IS NOT NULL);
CREATE POLICY team_library_insert ON prism.team_libraries FOR INSERT
  WITH CHECK (created_by=prism.principal() AND updated_by=prism.principal() AND deleted_at IS NULL);
CREATE POLICY team_library_update ON prism.team_libraries FOR UPDATE
  USING (prism.team_library_role(id)='admin') WITH CHECK (updated_by=prism.principal());

ALTER TABLE prism.team_library_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_members_read ON prism.team_library_members FOR SELECT
  USING (user_id=prism.principal() OR prism.team_library_role(library_id)='admin');
CREATE POLICY team_members_insert ON prism.team_library_members FOR INSERT
  WITH CHECK (prism.team_library_role(library_id)='admin' AND added_by=prism.principal() AND updated_by=prism.principal());
CREATE POLICY team_members_update ON prism.team_library_members FOR UPDATE
  USING (prism.team_library_role(library_id)='admin')
  WITH CHECK (prism.team_library_role(library_id)='admin' AND updated_by=prism.principal());

ALTER TABLE prism.team_library_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_library_references FORCE ROW LEVEL SECURITY;
CREATE POLICY team_reference_read ON prism.team_library_references FOR SELECT
  USING (prism.team_library_role(library_id) IS NOT NULL);
CREATE POLICY team_reference_insert ON prism.team_library_references FOR INSERT
  WITH CHECK (prism.team_library_role(library_id) IN ('admin','editor') AND created_by=prism.principal()
    AND updated_by=prism.principal() AND deleted_at IS NULL);
CREATE POLICY team_reference_update ON prism.team_library_references FOR UPDATE
  USING (prism.team_library_role(library_id) IN ('admin','editor'))
  WITH CHECK (prism.team_library_role(library_id) IN ('admin','editor') AND updated_by=prism.principal());

ALTER TABLE prism.team_library_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_library_events FORCE ROW LEVEL SECURITY;
CREATE POLICY team_events_insert ON prism.team_library_events FOR INSERT
  WITH CHECK (actor_id=prism.principal() AND (
    (action LIKE 'reference_%' AND prism.team_library_role(library_id) IN ('admin','editor')) OR
    (action NOT LIKE 'reference_%' AND prism.team_library_role(library_id)='admin')
  ));
CREATE TRIGGER team_events_immutable BEFORE UPDATE OR DELETE ON prism.team_library_events
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
