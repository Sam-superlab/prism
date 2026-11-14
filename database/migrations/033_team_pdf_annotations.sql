ALTER TABLE prism.team_library_attachments ADD UNIQUE (library_id,reference_id,id);

CREATE TABLE prism.team_pdf_annotations (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 100000),
  kind text NOT NULL CHECK (kind IN ('highlight','underline','note','area','ink')),
  color text NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','blue','pink','purple')),
  text text NOT NULL DEFAULT '' CHECK (length(text) <= 12000),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 12000),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags)<=20),
  rects jsonb NOT NULL CHECK (jsonb_typeof(rects)='array' AND jsonb_array_length(rects) BETWEEN 1 AND 300),
  ink_path jsonb,
  created_by uuid NOT NULL REFERENCES prism.users(id),
  updated_by uuid NOT NULL REFERENCES prism.users(id),
  created_by_name text NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 200),
  updated_by_name text NOT NULL CHECK (length(updated_by_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (library_id,reference_id,attachment_id) REFERENCES prism.team_library_attachments(library_id,reference_id,id),
  CHECK (kind <> 'note' OR (jsonb_array_length(rects)=1 AND length(trim(comment))>0)),
  CHECK (kind <> 'area' OR jsonb_array_length(rects)=1),
  CHECK (CASE WHEN kind='ink' THEN ink_path IS NOT NULL AND jsonb_typeof(ink_path)='array'
    AND jsonb_array_length(ink_path) BETWEEN 2 AND 512 AND jsonb_array_length(rects)=1 ELSE ink_path IS NULL END)
);
CREATE INDEX team_pdf_annotations_page ON prism.team_pdf_annotations(library_id,attachment_id,page,created_at,id)
  WHERE deleted_at IS NULL;

ALTER TABLE prism.team_pdf_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.team_pdf_annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY team_annotation_read ON prism.team_pdf_annotations FOR SELECT
  USING (prism.team_library_attachment_permission(library_id,false));
CREATE POLICY team_annotation_insert ON prism.team_pdf_annotations FOR INSERT
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND created_by=prism.principal()
    AND updated_by=prism.principal() AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM prism.team_library_attachments a
      WHERE a.library_id=team_pdf_annotations.library_id AND a.reference_id=team_pdf_annotations.reference_id
        AND a.id=attachment_id AND a.deleted_at IS NULL));
CREATE POLICY team_annotation_update ON prism.team_pdf_annotations FOR UPDATE
  USING (prism.team_library_attachment_permission(library_id,true) AND deleted_at IS NULL
    AND (created_by=prism.principal() OR prism.team_library_role(library_id)='admin'))
  WITH CHECK (prism.team_library_attachment_permission(library_id,true) AND updated_by=prism.principal()
    AND (created_by=prism.principal() OR prism.team_library_role(library_id)='admin'));

-- Removing a parent as an authorized editor archives all its annotations as part of that operation.
CREATE FUNCTION prism.archive_team_pdf_annotations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, prism AS $$
BEGIN
  UPDATE prism.team_pdf_annotations SET deleted_at=NEW.deleted_at,updated_at=now(),version=version+1,
    updated_by=prism.principal(),updated_by_name=prism.team_library_account_name(NEW.library_id,prism.principal())
  WHERE library_id=NEW.library_id AND attachment_id=NEW.id AND deleted_at IS NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION prism.archive_team_pdf_annotations() FROM PUBLIC;
CREATE POLICY team_annotation_archive_parent ON prism.team_pdf_annotations FOR UPDATE
  USING (current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='prism.team_pdf_annotations'::regclass)
    AND prism.team_library_attachment_permission(library_id,true) AND deleted_at IS NULL)
  WITH CHECK (current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='prism.team_pdf_annotations'::regclass)
    AND deleted_at IS NOT NULL AND updated_by=prism.principal());
CREATE TRIGGER archive_team_pdf_annotations AFTER UPDATE OF deleted_at ON prism.team_library_attachments
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION prism.archive_team_pdf_annotations();

ALTER TABLE prism.team_library_events DROP CONSTRAINT team_library_events_action_check;
ALTER TABLE prism.team_library_events ADD CONSTRAINT team_library_events_action_check
  CHECK (action IN ('library_created','library_updated','library_deleted','member_added','member_joined','member_updated','member_removed',
    'reference_created','reference_updated','reference_deleted','reference_attachment_created','reference_attachment_deleted',
    'reference_note_created','reference_note_updated','reference_note_deleted',
    'reference_annotation_created','reference_annotation_updated','reference_annotation_deleted'));
