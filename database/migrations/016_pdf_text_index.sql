CREATE TABLE prism.research_pdf_text_indexes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  pdf_id uuid NOT NULL,
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 2000),
  next_page integer NOT NULL DEFAULT 1 CHECK (next_page BETWEEN 1 AND page_count+1),
  status text NOT NULL DEFAULT 'indexing' CHECK (status IN ('indexing','ready','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, pdf_id) REFERENCES prism.research_reference_pdfs(user_id, id),
  CHECK (status <> 'ready' OR next_page=page_count+1)
);

CREATE UNIQUE INDEX research_pdf_text_index_active
  ON prism.research_pdf_text_indexes(user_id,pdf_id,status)
  WHERE status IN ('indexing','ready');

CREATE TABLE prism.research_pdf_page_text (
  user_id uuid NOT NULL,
  index_id uuid NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 2000),
  text text CHECK (length(text) <= 12000),
  search_text text CHECK (length(search_text) <= 36000),
  PRIMARY KEY (user_id,index_id,page),
  FOREIGN KEY (user_id,index_id) REFERENCES prism.research_pdf_text_indexes(user_id,id),
  CHECK ((text IS NULL) = (search_text IS NULL))
);

ALTER TABLE prism.research_pdf_text_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_pdf_text_indexes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_pdf_text_indexes
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());

ALTER TABLE prism.research_pdf_page_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_pdf_page_text FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_pdf_page_text
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());

ALTER TABLE prism.research_pdf_annotations ADD COLUMN IF NOT EXISTS search_text text;
