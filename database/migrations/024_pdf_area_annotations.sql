ALTER TABLE prism.research_pdf_annotations
  DROP CONSTRAINT research_pdf_annotations_kind_check,
  ADD CONSTRAINT research_pdf_annotations_kind_check
    CHECK (kind IN ('highlight','underline','note','area')),
  ADD CONSTRAINT research_pdf_annotations_area_shape
    CHECK (kind <> 'area' OR jsonb_array_length(rects)=1);
