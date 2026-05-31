// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/secrets-redaction`
 * Purpose: Best-effort secrets/credential redaction for persisted message content.
 * Scope: Regex-based redaction of API keys, tokens, and credential patterns. NOT general PII masking.
 * Invariants:
 *   - REDACT_SECRETS_BEFORE_PERSIST: applied before saveThread()
 *   - Best-effort only — stored content must still be treated as sensitive data via RLS + retention
 * Side-effects: none
 * Links: docs/spec/thread-persistence.md
 * @public
 */

import type { UIMessage } from "ai";

/**
 * Patterns for common secret/credential formats.
 * Order matters — more specific patterns first to avoid partial matches.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  // Generic API keys (sk-*, key-*, token-*, api-* prefixed)
  {
    pattern: /\b(sk|key|token|api)[-_][a-zA-Z0-9_-]{20,}\b/gi,
    replacement: "[REDACTED_API_KEY]",
  },
  // Bearer tokens
  {
    pattern: /Bearer\s+[a-zA-Z0-9._~+/=-]{20,}/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_)
  {
    pattern: /\bgh[pohsr]_[a-zA-Z0-9]{36,}\b/g,
    replacement: "[REDACTED_GH_TOKEN]",
  },
  // JWT tokens (eyJ... base64url header)
  {
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: "[REDACTED_JWT]",
  },
];

/**
 * Apply best-effort secret redaction to a string.
 */
function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact secrets/credentials from a UIMessage array before persistence.
 *
 * Per REDACT_SECRETS_BEFORE_PERSIST: redacts API keys, tokens, and credential patterns
 * in text parts. Tool call args and results are also redacted.
 *
 * Returns a new array — does not mutate the input.
 */
export function redactSecretsInMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => ({
    ...msg,
    parts: msg.parts.map((part) => {
      if (part.type === "text") {
        return { ...part, text: redactSecrets(part.text) };
      }
      // Redact tool inputs and outputs
      if (part.type === "dynamic-tool") {
        const masked = { ...part } as Record<string, unknown>;
        if (
          "input" in part &&
          part.input !== undefined &&
          part.input !== null
        ) {
          masked.input = JSON.parse(redactSecrets(JSON.stringify(part.input)));
        }
        if (
          "output" in part &&
          part.output !== undefined &&
          part.output !== null
        ) {
          masked.output = JSON.parse(
            redactSecrets(JSON.stringify(part.output))
          );
        }
        return masked;
      }
      return part;
    }),
  })) as UIMessage[];
}
