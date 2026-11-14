ALTER TABLE prism.team_library_references ADD COLUMN tags text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(tags) <= 40);

CREATE TABLE prism.team_library_notes (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  content text NOT NULL DEFAULT '' CHECK (length(content) <= 64000),
  created_by uuid NOT NULL REFERENCES prism.users(id),
  updated_by uuid NOT NULL REFERENCES prism.users(id),
  created_by_name text NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 200),
  updated_by_name text NOT NULL CHECK (length(updated_by_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (library_id,reference_id) REFERENCES prism.team_library_references(library_id,id)
);
CREATE INDEX team_library_notes_recent ON prism.team_library_notes(library_id,reference_id,created_at DESC,id DESC)
  WHERE deleted_at IS NULL;
ALTER TABLE prism.team_library_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_library_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY team_note_read ON prism.team_library_notes FOR SELECT
  USING (prism.team_library_attachment_permission(library_id,false));
CREATE POLICY team_note_insert ON prism.team_library_notes FOR INSERT
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND created_by=prism.principal()
    AND updated_by=prism.principal() AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM prism.team_library_references r
      WHERE r.library_id=team_library_notes.library_id AND r.id=reference_id AND r.deleted_at IS NULL));
CREATE POLICY team_note_update ON prism.team_library_notes FOR UPDATE
  USING (prism.team_library_attachment_permission(library_id,true) AND deleted_at IS NULL)
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND updated_by=prism.principal());

CREATE FUNCTION prism.protect_team_open_with_notes() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, prism AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM prism.team_library_notes n WHERE n.library_id=OLD.id AND n.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'team library retains notes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER team_open_with_notes BEFORE UPDATE OF visibility ON prism.team_libraries
  FOR EACH ROW WHEN (OLD.visibility<>'public_open' AND NEW.visibility='public_open')
  EXECUTE FUNCTION prism.protect_team_open_with_notes();

ALTER TABLE prism.team_library_events DROP CONSTRAINT team_library_events_action_check;
ALTER TABLE prism.team_library_events ADD CONSTRAINT team_library_events_action_check
  CHECK (action IN ('library_created','library_updated','library_deleted','member_added','member_joined','member_updated','member_removed',
    'reference_created','reference_updated','reference_deleted','reference_attachment_created','reference_attachment_deleted',
    'reference_note_created','reference_note_updated','reference_note_deleted'));
