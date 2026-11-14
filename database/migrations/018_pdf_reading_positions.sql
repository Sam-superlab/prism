CREATE TABLE prism.research_pdf_reading_positions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  pdf_id uuid NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  CHECK (id=pdf_id),
  UNIQUE (user_id,pdf_id),
  FOREIGN KEY (user_id,pdf_id) REFERENCES prism.research_reference_pdfs(user_id,id)
);

ALTER TABLE prism.research_pdf_reading_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_pdf_reading_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_pdf_reading_positions
  USING (user_id=prism.principal()) WITH CHECK (user_id=prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_pdf_reading_positions
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
