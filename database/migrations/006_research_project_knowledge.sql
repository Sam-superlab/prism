ALTER TABLE prism.research_knowledge_links
  ALTER COLUMN research_object_id DROP NOT NULL,
  ADD COLUMN project_id uuid,
  ADD CONSTRAINT research_knowledge_link_target
    CHECK (num_nonnulls(research_object_id, project_id) = 1),
  ADD CONSTRAINT research_knowledge_link_project
    FOREIGN KEY (user_id, project_id) REFERENCES prism.research_projects(user_id, id);

CREATE UNIQUE INDEX research_project_knowledge_active
  ON prism.research_knowledge_links(user_id, project_id, knowledge_item_id)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
