ALTER TABLE prism.research_pdf_annotations
  DROP CONSTRAINT research_pdf_annotations_kind_check,
  ADD CONSTRAINT research_pdf_annotations_kind_check
    CHECK (kind IN ('highlight','underline','note')),
  ADD CONSTRAINT research_pdf_annotations_note_shape
    CHECK (kind <> 'note' OR (jsonb_array_length(rects)=1 AND length(trim(comment))>0));
