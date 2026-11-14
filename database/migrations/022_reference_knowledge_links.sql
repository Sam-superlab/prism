CREATE TABLE prism.research_reference_knowledge_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  reference_id uuid NOT NULL,
  knowledge_item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id,id),
  FOREIGN KEY (user_id,reference_id) REFERENCES prism.research_references(user_id,id),
  FOREIGN KEY (user_id,knowledge_item_id) REFERENCES prism.knowledge_items(user_id,id)
);

CREATE UNIQUE INDEX research_reference_knowledge_pair
  ON prism.research_reference_knowledge_links(user_id,reference_id,knowledge_item_id)
  WHERE deleted_at IS NULL;
CREATE INDEX research_reference_knowledge_item
  ON prism.research_reference_knowledge_links(user_id,knowledge_item_id,reference_id)
  WHERE deleted_at IS NULL;

ALTER TABLE prism.research_reference_knowledge_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_reference_knowledge_links FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_reference_knowledge_links
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_reference_knowledge_links
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();
