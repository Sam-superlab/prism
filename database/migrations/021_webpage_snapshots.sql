ALTER TABLE prism.research_reference_pdfs
  DROP CONSTRAINT research_reference_pdfs_format_check,
  ADD CONSTRAINT research_reference_pdfs_format_check
    CHECK (format IN ('pdf','epub','webpage')),
  ADD CONSTRAINT research_reference_webpage_size_check
    CHECK (format <> 'webpage' OR size_bytes <= 262144);
