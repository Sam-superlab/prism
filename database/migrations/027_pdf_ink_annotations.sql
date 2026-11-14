ALTER TABLE prism.research_pdf_annotations
  ADD COLUMN ink_path jsonb,
  DROP CONSTRAINT research_pdf_annotations_kind_check,
  ADD CONSTRAINT research_pdf_annotations_kind_check
    CHECK (kind IN ('highlight','underline','note','area','ink')),
  ADD CONSTRAINT research_pdf_annotations_ink_shape
    CHECK (
      CASE WHEN kind = 'ink' THEN
        ink_path IS NOT NULL AND jsonb_typeof(ink_path) = 'array'
        AND jsonb_array_length(ink_path) BETWEEN 2 AND 512
        AND jsonb_array_length(rects) = 1
      ELSE ink_path IS NULL END
    );
