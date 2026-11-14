ALTER TABLE prism.team_libraries
  ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','public_closed','public_open'));

CREATE INDEX team_libraries_public ON prism.team_libraries(id)
  WHERE visibility<>'private' AND deleted_at IS NULL;

-- Public read queries use this narrowly scoped predicate instead of granting anonymous table access.
CREATE FUNCTION prism.team_library_public(library uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
  SELECT EXISTS(SELECT 1 FROM prism.team_libraries WHERE id=library AND visibility<>'private' AND deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION prism.team_library_public(uuid) FROM PUBLIC;

CREATE FUNCTION prism.public_team_libraries(library uuid, after_id uuid, page_limit integer)
RETURNS TABLE(id uuid,name text,description text,visibility text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
  SELECT t.id,t.name,t.description,t.visibility FROM prism.team_libraries t
  WHERE prism.principal() IS NULL AND t.visibility<>'private' AND t.deleted_at IS NULL
    AND (library IS NULL OR t.id=library) AND (after_id IS NULL OR t.id>after_id)
  ORDER BY t.id LIMIT least(greatest(coalesce(page_limit,1),1),101)
$$;
REVOKE ALL ON FUNCTION prism.public_team_libraries(uuid,uuid,integer) FROM PUBLIC;

CREATE POLICY team_reference_public_projection ON prism.team_library_references FOR SELECT
  USING (current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='prism.team_library_references'::regclass)
    AND prism.principal() IS NULL AND deleted_at IS NULL AND prism.team_library_public(library_id));

CREATE FUNCTION prism.public_team_library_references(library uuid, after_time timestamptz, after_id uuid, page_limit integer)
RETURNS TABLE(id uuid,title text,authors text[],year integer,doi text,url text,publication jsonb,cursor_time text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, prism AS $$
  SELECT r.id,r.title,r.authors,r.year,r.doi,r.url,r.publication,r.created_at::text
  FROM prism.team_library_references r WHERE r.library_id=library AND r.deleted_at IS NULL
    AND prism.principal() IS NULL AND prism.team_library_public(library)
    AND (after_id IS NULL OR (r.created_at,r.id)<(after_time,after_id))
  ORDER BY r.created_at DESC,r.id DESC LIMIT least(greatest(coalesce(page_limit,1),1),101)
$$;
REVOKE ALL ON FUNCTION prism.public_team_library_references(uuid,timestamptz,uuid,integer) FROM PUBLIC;

-- Joining is only possible for the signed-in account with an active public-open library.
-- Tombstones cannot conflict-update via this policy. An administrator may restore a removed member.
CREATE FUNCTION prism.team_library_open(library uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
  SELECT EXISTS(SELECT 1 FROM prism.team_libraries WHERE id=library AND visibility='public_open' AND deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION prism.team_library_open(uuid) FROM PUBLIC;

CREATE POLICY team_members_open_join ON prism.team_library_members FOR INSERT
  WITH CHECK (prism.team_library_open(library_id) AND user_id=prism.principal() AND role='reader'
    AND added_by=prism.principal() AND updated_by=prism.principal() AND deleted_at IS NULL);

ALTER TABLE prism.team_library_events DROP CONSTRAINT team_library_events_action_check;
ALTER TABLE prism.team_library_events ADD CONSTRAINT team_library_events_action_check
  CHECK (action IN ('library_created','library_updated','library_deleted','member_added','member_joined','member_updated','member_removed','reference_created','reference_updated','reference_deleted'));
CREATE POLICY team_events_open_join ON prism.team_library_events FOR INSERT
  WITH CHECK (action='member_joined' AND actor_id=prism.principal() AND subject_id=prism.principal()
    AND prism.team_library_open(library_id) AND prism.team_library_role(library_id)='reader');
