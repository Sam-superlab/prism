CREATE TABLE prism.research_pdf_annotations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  pdf_id uuid NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 100000),
  kind text NOT NULL CHECK (kind IN ('highlight','underline')),
  color text NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','blue','pink','purple')),
  text text NOT NULL DEFAULT '' CHECK (length(text) <= 12000),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 12000),
  rects jsonb NOT NULL CHECK (jsonb_typeof(rects)='array' AND jsonb_array_length(rects) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, pdf_id) REFERENCES prism.research_reference_pdfs(user_id, id)
);

CREATE INDEX research_pdf_annotations_page
  ON prism.research_pdf_annotations(user_id, pdf_id, page, created_at, id)
  WHERE deleted_at IS NULL;
ALTER TABLE prism.research_pdf_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_pdf_annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_pdf_annotations
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_pdf_annotations
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
