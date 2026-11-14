ALTER TABLE prism.team_library_references ADD UNIQUE (library_id,id);

CREATE TABLE prism.team_library_attachments (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 33554432),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES prism.users(id),
  created_by_name text NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE(library_id,id),
  FOREIGN KEY (library_id,reference_id) REFERENCES prism.team_library_references(library_id,id)
);
CREATE UNIQUE INDEX team_library_attachment_digest ON prism.team_library_attachments(library_id,reference_id,sha256)
  WHERE deleted_at IS NULL;

CREATE TABLE prism.team_library_attachment_chunks (
  library_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  byte_offset integer NOT NULL CHECK (byte_offset BETWEEN 0 AND 33554431),
  data bytea CHECK (octet_length(data) BETWEEN 1 AND 524288),
  PRIMARY KEY (library_id,attachment_id,byte_offset),
  FOREIGN KEY (library_id,attachment_id) REFERENCES prism.team_library_attachments(library_id,id)
);

CREATE FUNCTION prism.team_library_attachment_permission(library uuid, require_edit boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, prism AS $$
  SELECT EXISTS(SELECT 1 FROM prism.team_libraries t WHERE t.id=library AND t.deleted_at IS NULL
    AND t.visibility<>'public_open' AND CASE WHEN require_edit THEN prism.team_library_role(library) IN ('admin','editor')
      ELSE prism.team_library_role(library) IS NOT NULL END)
$$;
REVOKE ALL ON FUNCTION prism.team_library_attachment_permission(uuid,boolean) FROM PUBLIC;

ALTER TABLE prism.team_library_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_library_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY team_attachment_read ON prism.team_library_attachments FOR SELECT
  USING (prism.team_library_attachment_permission(library_id,false));
CREATE POLICY team_attachment_insert ON prism.team_library_attachments FOR INSERT
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND created_by=prism.principal()
    AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM prism.team_library_references r
      WHERE r.library_id=team_library_attachments.library_id AND r.id=reference_id AND r.deleted_at IS NULL));
CREATE POLICY team_attachment_remove ON prism.team_library_attachments FOR UPDATE
  USING (prism.team_library_attachment_permission(library_id,true) AND deleted_at IS NULL)
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND deleted_at IS NOT NULL);

ALTER TABLE prism.team_library_attachment_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_library_attachment_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY team_attachment_chunk_read ON prism.team_library_attachment_chunks FOR SELECT
  USING (prism.team_library_attachment_permission(library_id,false) AND EXISTS(
    SELECT 1 FROM prism.team_library_attachments a WHERE a.library_id=team_library_attachment_chunks.library_id
      AND a.id=attachment_id AND a.deleted_at IS NULL));
CREATE POLICY team_attachment_chunk_insert ON prism.team_library_attachment_chunks FOR INSERT
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND data IS NOT NULL AND EXISTS(
    SELECT 1 FROM prism.team_library_attachments a WHERE a.library_id=team_library_attachment_chunks.library_id
      AND a.id=attachment_id AND a.deleted_at IS NULL AND a.created_by=prism.principal()));
CREATE POLICY team_attachment_chunk_clear ON prism.team_library_attachment_chunks FOR UPDATE
  USING (prism.team_library_attachment_permission(library_id,true))
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND data IS NULL);

CREATE FUNCTION prism.protect_team_open_with_attachments() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, prism AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM prism.team_library_attachments a WHERE a.library_id=OLD.id AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'team library retains attachments' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER team_open_with_attachments BEFORE UPDATE OF visibility ON prism.team_libraries
  FOR EACH ROW WHEN (OLD.visibility<>'public_open' AND NEW.visibility='public_open')
  EXECUTE FUNCTION prism.protect_team_open_with_attachments();

ALTER TABLE prism.team_library_events DROP CONSTRAINT team_library_events_action_check;
ALTER TABLE prism.team_library_events ADD CONSTRAINT team_library_events_action_check
  CHECK (action IN ('library_created','library_updated','library_deleted','member_added','member_joined','member_updated','member_removed',
    'reference_created','reference_updated','reference_deleted','reference_attachment_created','reference_attachment_deleted'));
