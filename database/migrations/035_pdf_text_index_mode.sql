ALTER TABLE prism.research_pdf_text_indexes
  ADD COLUMN text_mode text NOT NULL DEFAULT 'embedded'
  CHECK (text_mode IN ('embedded', 'local-ocr'));
