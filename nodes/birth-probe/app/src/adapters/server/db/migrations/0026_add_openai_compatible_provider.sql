-- Add 'openai-compatible' to connections.provider CHECK constraint
-- Supports user-hosted OpenAI-compatible endpoints (Ollama, vLLM, llama.cpp, LM Studio)

ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_provider_check;
ALTER TABLE connections ADD CONSTRAINT connections_provider_check
  CHECK (provider IN ('openai-chatgpt', 'openai-compatible', 'github', 'google', 'bluesky'));
