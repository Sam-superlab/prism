ALTER TABLE prism.research_references
  ALTER COLUMN project_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS citation_key text CHECK (citation_key ~ '^[A-Za-z0-9_./:+-]{1,180}$'),
  ADD COLUMN IF NOT EXISTS publication jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS research_references_standalone_doi
  ON prism.research_references(user_id, doi)
  WHERE deleted_at IS NULL AND project_id IS NULL AND doi IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_references_standalone_arxiv
  ON prism.research_references(user_id, arxiv_id)
  WHERE deleted_at IS NULL AND project_id IS NULL AND arxiv_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_references_standalone_zotero
  ON prism.research_references(user_id, zotero_key)
  WHERE deleted_at IS NULL AND project_id IS NULL AND zotero_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_references_citation_key
  ON prism.research_references(user_id, citation_key)
  WHERE deleted_at IS NULL AND citation_key IS NOT NULL;
