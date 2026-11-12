CREATE TABLE prism.research_references (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  authors text[] NOT NULL DEFAULT '{}',
  year integer CHECK (year BETWEEN 1 AND 9999),
  doi text,
  arxiv_id text,
  url text,
  zotero_key text CHECK (zotero_key ~ '^[A-Z0-9]{8}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, project_id) REFERENCES prism.research_projects(user_id, id)
);

ALTER TABLE prism.research_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_references FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_references
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_references
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
CREATE INDEX research_references_project ON prism.research_references(user_id, project_id, created_at, id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX research_references_zotero ON prism.research_references(user_id, project_id, zotero_key)
  WHERE deleted_at IS NULL AND zotero_key IS NOT NULL;
CREATE UNIQUE INDEX research_references_doi ON prism.research_references(user_id, project_id, doi)
  WHERE deleted_at IS NULL AND doi IS NOT NULL;
CREATE UNIQUE INDEX research_references_arxiv ON prism.research_references(user_id, project_id, arxiv_id)
  WHERE deleted_at IS NULL AND arxiv_id IS NOT NULL;
