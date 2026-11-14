CREATE TABLE prism.developer_literature_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES prism.users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+interval '90 days'),
  revoked_at timestamptz
);
CREATE INDEX developer_literature_tokens_owner ON prism.developer_literature_tokens(user_id,created_at DESC,id DESC);
ALTER TABLE prism.developer_literature_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY developer_token_owner ON prism.developer_literature_tokens
  USING (user_id=prism.principal()) WITH CHECK (user_id=prism.principal());

-- The database role can resolve only an exact cryptographic secret, never enumerate other accounts.
CREATE FUNCTION prism.developer_literature_token_account(token uuid, candidate text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,prism AS $$
  SELECT t.user_id FROM prism.developer_literature_tokens t
  WHERE t.id=token AND t.secret_hash=candidate AND t.revoked_at IS NULL AND t.expires_at>now()
$$;
REVOKE ALL ON FUNCTION prism.developer_literature_token_account(uuid,text) FROM PUBLIC;
