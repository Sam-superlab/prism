ALTER TABLE prism.developer_literature_tokens
  ADD COLUMN scope text NOT NULL DEFAULT 'bibliography'
  CONSTRAINT developer_literature_token_scope_check CHECK (scope IN ('bibliography', 'attachment_manifest'));
