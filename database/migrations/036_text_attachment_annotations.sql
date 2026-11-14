CREATE TABLE prism.research_text_annotations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  attachment_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('epub','webpage')),
  anchor jsonb NOT NULL CHECK (jsonb_typeof(anchor)='object'),
  section integer NOT NULL CHECK (section BETWEEN 1 AND 262145),
  color text NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','blue','pink','purple')),
  comment text NOT NULL DEFAULT '' CHECK (length(comment)<=12000),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags)<=20),
  search_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  deleted_at timestamptz,
  FOREIGN KEY (user_id,attachment_id) REFERENCES prism.research_reference_pdfs(user_id,id)
);
CREATE INDEX research_text_annotations_section
  ON prism.research_text_annotations(user_id,attachment_id,section,created_at DESC,id DESC) WHERE deleted_at IS NULL;
ALTER TABLE prism.research_text_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_text_annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_text_annotations
  USING (user_id=prism.principal()) WITH CHECK (user_id=prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_text_annotations
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
CREATE FUNCTION prism.protect_text_annotation_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id,NEW.attachment_id,NEW.format,NEW.anchor,NEW.section) IS DISTINCT FROM
     (OLD.user_id,OLD.attachment_id,OLD.format,OLD.anchor,OLD.section) THEN
    RAISE EXCEPTION 'immutable attachment text annotation anchor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_anchor BEFORE UPDATE ON prism.research_text_annotations
  FOR EACH ROW EXECUTE FUNCTION prism.protect_text_annotation_anchor();
