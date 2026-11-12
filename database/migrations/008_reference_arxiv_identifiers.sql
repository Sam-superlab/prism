-- Some local previews created References before arXiv identifiers were added.
ALTER TABLE prism.research_references ADD COLUMN IF NOT EXISTS arxiv_id text;

CREATE UNIQUE INDEX IF NOT EXISTS research_references_arxiv
  ON prism.research_references(user_id, project_id, arxiv_id)
  WHERE deleted_at IS NULL AND arxiv_id IS NOT NULL;
