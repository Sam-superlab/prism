ALTER TABLE prism.user_preferences
  ADD COLUMN IF NOT EXISTS arxiv_for_you_keywords jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(arxiv_for_you_keywords) = 'array');

ALTER TABLE prism.user_papers
  ADD COLUMN IF NOT EXISTS for_you_day date,
  ADD COLUMN IF NOT EXISTS for_you_position smallint CHECK (for_you_position BETWEEN 1 AND 6),
  ADD COLUMN IF NOT EXISTS for_you_reason text,
  ADD COLUMN IF NOT EXISTS for_you_reaction text
    CHECK (for_you_reaction IN ('interested', 'liked', 'not_interested', 'skip')),
  ADD COLUMN IF NOT EXISTS for_you_reacted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS user_papers_for_you_deck
  ON prism.user_papers (user_id, for_you_day, for_you_position) WHERE for_you_day IS NOT NULL;
