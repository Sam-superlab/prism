ALTER TABLE prism.research_objects
  ADD COLUMN question_status text
  CONSTRAINT research_object_question_status CHECK (
    question_status IS NULL OR (object_type = 'question' AND question_status IN ('open', 'investigating', 'resolved'))
  );

CREATE TABLE prism.research_question_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  project_id uuid NOT NULL,
  question_id uuid NOT NULL,
  relation_type text NOT NULL,
  reference_id uuid,
  attachment_id uuid,
  page integer CHECK (page BETWEEN 1 AND 100000),
  research_object_id uuid,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id,id),
  FOREIGN KEY (user_id,project_id,question_id) REFERENCES prism.research_objects(user_id,project_id,id),
  FOREIGN KEY (user_id,project_id,research_object_id) REFERENCES prism.research_objects(user_id,project_id,id),
  FOREIGN KEY (user_id,reference_id) REFERENCES prism.research_references(user_id,id),
  FOREIGN KEY (user_id,attachment_id) REFERENCES prism.research_reference_pdfs(user_id,id),
  CHECK ((attachment_id IS NULL) = (page IS NULL)),
  CHECK (
    (reference_id IS NOT NULL AND research_object_id IS NULL
      AND relation_type IN ('motivates','supports','contradicts','background'))
    OR
    (research_object_id IS NOT NULL AND research_object_id <> question_id
      AND reference_id IS NULL AND attachment_id IS NULL
      AND relation_type IN ('attempt','experiment','result','counterexample','conjecture'))
  )
);

CREATE UNIQUE INDEX research_question_source_unique ON prism.research_question_links
  (user_id,question_id,reference_id,attachment_id,page,relation_type) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX research_question_record_unique ON prism.research_question_links
  (user_id,question_id,research_object_id,relation_type)
  WHERE deleted_at IS NULL AND research_object_id IS NOT NULL;
CREATE INDEX research_question_links_by_question ON prism.research_question_links
  (user_id,question_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX research_question_links_by_record ON prism.research_question_links
  (user_id,research_object_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX research_question_links_by_source ON prism.research_question_links
  (user_id,reference_id) WHERE deleted_at IS NULL AND reference_id IS NOT NULL;
CREATE INDEX research_question_links_by_attachment ON prism.research_question_links
  (user_id,attachment_id) WHERE deleted_at IS NULL AND attachment_id IS NOT NULL;

ALTER TABLE prism.research_question_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_question_links FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_question_links
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_question_links
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
