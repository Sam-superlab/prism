ALTER TABLE prism.research_pdf_annotations
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT research_pdf_annotations_tags_count CHECK (cardinality(tags) <= 20);
