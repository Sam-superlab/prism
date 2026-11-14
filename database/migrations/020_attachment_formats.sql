ALTER TABLE prism.research_reference_pdfs
  ADD COLUMN format text NOT NULL DEFAULT 'pdf'
    CHECK (format IN ('pdf','epub'));
