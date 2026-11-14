ALTER TABLE prism.research_references
  ADD COLUMN IF NOT EXISTS citation_aliases text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS merged_into_id uuid;

ALTER TABLE prism.research_references
  ADD CONSTRAINT research_reference_merge_target
    FOREIGN KEY (user_id, merged_into_id) REFERENCES prism.research_references(user_id, id),
  ADD CONSTRAINT research_reference_merge_tombstone
    CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND deleted_at IS NOT NULL));
