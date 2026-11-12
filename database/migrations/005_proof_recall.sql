ALTER TABLE prism.review_cards
  ADD COLUMN IF NOT EXISTS proof_steps jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (
    jsonb_typeof(proof_steps) = 'array'
    AND jsonb_array_length(proof_steps) <= 12
    AND (card_type = 'proof' OR proof_steps = '[]'::jsonb)
  );

ALTER TABLE prism.review_events
  ADD COLUMN IF NOT EXISTS proof_stuck_steps jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(proof_stuck_steps) = 'array' AND jsonb_array_length(proof_stuck_steps) <= 12);
