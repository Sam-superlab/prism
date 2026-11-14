CREATE TABLE prism.research_reference_pdfs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  reference_id uuid NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 33554432),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready')),
  next_offset integer NOT NULL DEFAULT 0 CHECK (next_offset BETWEEN 0 AND size_bytes),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, reference_id) REFERENCES prism.research_references(user_id, id),
  CHECK (status <> 'ready' OR next_offset = size_bytes)
);

CREATE INDEX research_reference_pdf_ready
  ON prism.research_reference_pdfs(user_id, reference_id, sha256, id)
  WHERE deleted_at IS NULL AND status='ready';
CREATE INDEX research_reference_pdf_pending
  ON prism.research_reference_pdfs(user_id, updated_at, reference_id)
  WHERE deleted_at IS NULL AND status='uploading';

CREATE TABLE prism.research_reference_pdf_chunks (
  user_id uuid NOT NULL,
  pdf_id uuid NOT NULL,
  byte_offset integer NOT NULL CHECK (byte_offset BETWEEN 0 AND 33554431),
  data bytea CHECK (octet_length(data) BETWEEN 1 AND 524288),
  PRIMARY KEY (user_id, pdf_id, byte_offset),
  FOREIGN KEY (user_id, pdf_id) REFERENCES prism.research_reference_pdfs(user_id, id)
);

ALTER TABLE prism.research_reference_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_reference_pdfs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_reference_pdfs
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
CREATE TRIGGER no_hard_delete BEFORE DELETE ON prism.research_reference_pdfs
  FOR EACH ROW EXECUTE FUNCTION prism.protect_history();

ALTER TABLE prism.research_reference_pdf_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prism.research_reference_pdf_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON prism.research_reference_pdf_chunks
  USING (user_id = prism.principal()) WITH CHECK (user_id = prism.principal());
