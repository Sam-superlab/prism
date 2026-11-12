CREATE TABLE IF NOT EXISTS prism.ai_review_drafts (
  user_id uuid NOT NULL REFERENCES prism.users(id),
  note_date date NOT NULL,
  request_key uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running','ready','paused','failed')),
  items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items)='array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,note_date)
);

ALTER TABLE prism.ai_review_drafts ADD COLUMN IF NOT EXISTS resuming boolean NOT NULL DEFAULT false;
ALTER TABLE prism.ai_review_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.ai_review_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner ON prism.ai_review_drafts;
CREATE POLICY owner ON prism.ai_review_drafts
  USING (user_id=prism.principal()) WITH CHECK (user_id=prism.principal());
