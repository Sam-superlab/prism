ALTER TABLE prism.research_references ADD COLUMN creators jsonb
  CHECK (creators IS NULL OR (jsonb_typeof(creators)='array' AND jsonb_array_length(creators)<=300));
