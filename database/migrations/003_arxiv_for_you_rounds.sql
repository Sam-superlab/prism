ALTER TABLE prism.user_papers
  ADD COLUMN IF NOT EXISTS for_you_round integer NOT NULL DEFAULT 1 CHECK (for_you_round > 0);

CREATE UNIQUE INDEX IF NOT EXISTS user_papers_for_you_deck_round
  ON prism.user_papers (user_id, for_you_day, for_you_round, for_you_position)
  WHERE for_you_day IS NOT NULL;

DROP INDEX IF EXISTS prism.user_papers_for_you_deck;
