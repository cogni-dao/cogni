-- BYO-AI connections table: encrypted credential storage for external services
-- Per spec.tenant-connections: AEAD encrypted JSON blob with AAD binding

CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  encrypted_credentials BYTEA NOT NULL,
  encryption_key_id TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT REFERENCES users(id),
  CONSTRAINT connections_provider_check CHECK (provider IN ('openai-chatgpt', 'github', 'google', 'bluesky')),
  CONSTRAINT connections_credential_type_check CHECK (credential_type IN ('oauth2', 'api_key', 'app_password', 'github_app_installation'))
);

CREATE INDEX connections_billing_account_id_idx ON connections(billing_account_id);
CREATE UNIQUE INDEX connections_billing_account_provider_active_idx
  ON connections(billing_account_id, provider) WHERE revoked_at IS NULL;

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "connections"
  USING ("created_by_user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("created_by_user_id" = current_setting('app.current_user_id', true));
