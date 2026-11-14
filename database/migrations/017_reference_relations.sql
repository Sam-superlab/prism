CREATE TABLE prism.research_reference_relations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  first_reference_id uuid NOT NULL,
  second_reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  CHECK (first_reference_id < second_reference_id),
  FOREIGN KEY (user_id, first_reference_id) REFERENCES prism.research_references(user_id, id),
  FOREIGN KEY (user_id, second_reference_id) REFERENCES prism.research_references(user_id, id)
);

CREATE UNIQUE INDEX research_reference_relation_pair
  ON prism.research_reference_relations(user_id,first_reference_id,second_reference_id)
  WHERE deleted_at IS NULL;
CREATE INDEX research_reference_relation_second
  ON prism.research_reference_relations(user_id,second_reference_id,first_reference_id)
  WHERE deleted_at IS NULL;

ALTER TABLE prism.research_reference_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_reference_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_reference_relations
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_reference_relations
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
