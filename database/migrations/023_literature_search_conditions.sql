ALTER TABLE prism.literature_saved_searches
  ADD COLUMN conditions jsonb
    CHECK (conditions IS NULL OR jsonb_typeof(conditions)='object');
