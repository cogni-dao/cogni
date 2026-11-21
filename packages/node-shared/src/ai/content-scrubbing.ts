// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/ai/content-scrubbing`
 * Purpose: Structured redaction for sensitive content. Scrubs secrets/PII while preserving readability.
 * Scope: Key-based + regex scrubbing, payload limits, hash computation. Does not import adapters.
 * Invariants:
 *   - SCRUB_BEFORE_SEND: All content passes through scrubbing before external transmission (Langfuse, operator logs)
 *   - PAYLOAD_CAPS: Hard limits enforced; exceeded => summary + hash + bytes
 *   - BOUNDED_CONTENT: an optional byte ceiling preflights each regex replacement before allocation
 *   - USER_OPT_OUT: maskContent=true => hashes only
 * Side-effects: none (pure functions)
 * Links: OBSERVABILITY.md#langfuse-integration
 * @public
 */

import { createHash } from "node:crypto";

/**
 * Minimal message shape for scrubbing (dependency-pure, no @/core import).
 * Compatible with Message from @/core but decoupled for architectural compliance.
 */
interface ScrubbableMessage {
  role: string;
  content: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Keys that indicate sensitive data - redact entire value */
const SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "key",
  "password",
  "auth",
  "cookie",
  "bearer",
  "authorization",
  "credential",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
]);

/** Max recursion depth for object scrubbing */
const MAX_DEPTH = 10;

/** Payload size limits (bytes) */
export const PAYLOAD_LIMITS = {
  traceInput: 50 * 1024, // 50KB
  traceOutput: 50 * 1024, // 50KB
  generationIO: 100 * 1024, // 100KB
  toolSpanIO: 10 * 1024, // 10KB
} as const;

// ============================================================================
// Types
// ============================================================================

export interface ScrubbedTraceInput {
  messageCount: number;
  roles: string[];
  lastUserMessage: string | null;
  conversationPreview: string | null;
  contentHash: string;
  totalBytes: number;
}

export interface ScrubbedTraceOutput {
  status: "success" | "error" | "aborted" | "finalization_lost";
  assistantResponse: string | null;
  finishReason?: string;
  errorCode?: string;
  contentHash: string | null;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ScrubbedToolInput {
  argsSummary: unknown;
  argHash: string;
  argBytes: number;
}

export interface ScrubbedToolOutput {
  resultSummary: unknown;
  resultHash: string;
  resultBytes: number;
}

export interface MaskedPayload {
  masked: true;
  hash: string;
  bytes: number;
  reason: "user_opt_out" | "size_exceeded";
}

export interface PayloadSizeExceeded {
  truncated: true;
  hash: string;
  bytes: number;
  preview: string;
}

// ============================================================================
// Hash Computation
// ============================================================================

/**
 * Compute SHA-256 hash of content for correlation.
 */
export function computeContentHash(content: unknown): string {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

// ============================================================================
// Regex Scrubbing (for string leaves)
// ============================================================================

/**
 * Scrub sensitive patterns from string content.
 * Preserves readability while removing secrets/PII. A byte ceiling returns null
 * before any replacement pass would allocate an oversized result.
 */
export function scrubStringContent(text: string): string;
export function scrubStringContent(
  text: string,
  maxBytes: number
): string | null;
export function scrubStringContent(
  text: string,
  maxBytes?: number
): string | null {
  if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) return null;
  // Keep one rule set for both ordinary callers and bounded read projections.
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED_SK_KEY]"],
    [/pk-[a-zA-Z0-9]{20,}/g, "[REDACTED_PK_KEY]"],
    [/sk-proj-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
    [/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED_SLACK_TOKEN]"],
    [/ghp_[a-zA-Z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
    [/gho_[a-zA-Z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
    [/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]"],
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]"],
    [/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, "[REDACTED_CARD]"],
    [/password["']?\s*[:=]\s*["']?[^"'\s,}]{4,}/gi, "password: [REDACTED]"],
    [
      /\b([A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|AUTH|CREDENTIAL)[A-Z_]*)\s*=\s*\S+/g,
      "$1=[REDACTED]",
    ],
    [/AKIA[A-Z0-9]{16}/g, "[REDACTED_AWS_KEY]"],
    [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]"],
  ];
  let safe = text;
  for (const [pattern, replacement] of rules) {
    if (maxBytes !== undefined) {
      let bytes = 0,
        copiedThrough = 0;
      // Detection/counting only. Retain one match at a time; do not construct expanded text.
      for (let match = pattern.exec(safe); match; match = pattern.exec(safe)) {
        const replacementBytes = replacement.includes("$1")
          ? Buffer.byteLength(replacement) -
            2 +
            Buffer.byteLength(match[1] ?? "")
          : Buffer.byteLength(replacement);
        bytes +=
          Buffer.byteLength(safe.slice(copiedThrough, match.index)) +
          replacementBytes;
        if (bytes > maxBytes) return null;
        copiedThrough = match.index + match[0].length;
      }
      if (bytes + Buffer.byteLength(safe.slice(copiedThrough)) > maxBytes)
        return null;
      pattern.lastIndex = 0;
    }
    // Bounded calls measure each pass before native replace allocates its result.
    safe = safe.replace(pattern, replacement);
  }
  return safe;
}

// ============================================================================
// Structured Redaction (recursive)
// ============================================================================

/**
 * Check if a key name indicates sensitive data.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEYS.has(normalized);
}

/**
 * Recursively scrub an object, redacting sensitive keys and applying regex to strings.
 */
export function scrubObject(obj: unknown, depth: number = 0): unknown {
  // Depth limit
  if (depth > MAX_DEPTH) {
    return "[MAX_DEPTH_EXCEEDED]";
  }

  // Handle primitives
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return scrubStringContent(obj);
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item, depth + 1));
  }

  // Handle objects
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = scrubObject(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

// ============================================================================
// Payload Size Enforcement
// ============================================================================

/**
 * Enforce payload size limit. Returns truncated summary if exceeded.
 */
export function enforcePayloadLimit(
  content: unknown,
  limitBytes: number
): unknown | PayloadSizeExceeded {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  const bytes = Buffer.byteLength(serialized, "utf8");

  if (bytes <= limitBytes) {
    return content;
  }

  // Exceeded - return summary
  const preview =
    typeof content === "string"
      ? `${content.slice(0, 200)}...`
      : `${JSON.stringify(content).slice(0, 200)}...`;

  return {
    truncated: true,
    hash: computeContentHash(content),
    bytes,
    preview,
  };
}

// ============================================================================
// Trace Input Scrubbing
// ============================================================================

/**
 * Scrub messages for Langfuse trace input.
 * Returns readable scrubbed content with structure preserved.
 */
export function scrubTraceInput(
  messages: ScrubbableMessage[]
): ScrubbedTraceInput {
  const serialized = JSON.stringify(messages);
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  const contentHash = computeContentHash(messages);

  // Extract last user message
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  const lastUserContent = lastUserMsg?.content ?? null;
  const scrubbedLastUser = lastUserContent
    ? scrubStringContent(lastUserContent)
    : null;

  // Build conversation preview (last 3 messages, truncated)
  const recentMessages = messages.slice(-3);
  const conversationPreview = recentMessages
    .map((m) => {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const truncated =
        content.length > 100 ? `${content.slice(0, 100)}...` : content;
      return `${m.role}: ${scrubStringContent(truncated)}`;
    })
    .join("\n");

  return {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    lastUserMessage: scrubbedLastUser,
    conversationPreview:
      totalBytes > PAYLOAD_LIMITS.traceInput ? null : conversationPreview,
    contentHash,
    totalBytes,
  };
}

/**
 * Scrub assistant response for Langfuse trace output.
 */
export function scrubTraceOutput(
  content: string | null,
  terminal: {
    status: ScrubbedTraceOutput["status"];
    finishReason?: string;
    errorCode?: string;
    usage?: { promptTokens: number; completionTokens: number };
  }
): ScrubbedTraceOutput {
  const scrubbedContent = content ? scrubStringContent(content) : null;
  const contentHash = content ? computeContentHash(content) : null;

  // Enforce size limit on assistant response
  const limitedContent =
    scrubbedContent && scrubbedContent.length > PAYLOAD_LIMITS.traceOutput
      ? `${scrubbedContent.slice(0, PAYLOAD_LIMITS.traceOutput)}...[TRUNCATED]`
      : scrubbedContent;

  return {
    status: terminal.status,
    assistantResponse: limitedContent,
    contentHash,
    ...(terminal.finishReason && { finishReason: terminal.finishReason }),
    ...(terminal.errorCode && { errorCode: terminal.errorCode }),
    ...(terminal.usage && { usage: terminal.usage }),
  };
}

// ============================================================================
// Tool Span Scrubbing
// ============================================================================

/**
 * Scrub tool arguments for Langfuse span input.
 */
export function scrubToolInput(args: unknown): ScrubbedToolInput {
  const serialized = JSON.stringify(args);
  const argBytes = Buffer.byteLength(serialized, "utf8");
  const argHash = computeContentHash(args);

  // Scrub and enforce limit
  const scrubbed = scrubObject(args);
  const limited = enforcePayloadLimit(scrubbed, PAYLOAD_LIMITS.toolSpanIO);

  return {
    argsSummary: limited,
    argHash,
    argBytes,
  };
}

/**
 * Scrub tool result for Langfuse span output.
 */
export function scrubToolOutput(result: unknown): ScrubbedToolOutput {
  const serialized = JSON.stringify(result);
  const resultBytes = Buffer.byteLength(serialized, "utf8");
  const resultHash = computeContentHash(result);

  // Scrub and enforce limit
  const scrubbed = scrubObject(result);
  const limited = enforcePayloadLimit(scrubbed, PAYLOAD_LIMITS.toolSpanIO);

  return {
    resultSummary: limited,
    resultHash,
    resultBytes,
  };
}

// ============================================================================
// User Opt-Out (maskContent=true)
// ============================================================================

/**
 * Apply user masking preference.
 * If maskContent=true, returns only hashes and counts (no readable content).
 */
export function applyUserMaskingPreference<
  T extends ScrubbedTraceInput | ScrubbedTraceOutput,
>(scrubbed: T, maskContent: boolean): T | MaskedPayload {
  if (!maskContent) {
    return scrubbed;
  }

  // User opted out - strip readable content
  if ("lastUserMessage" in scrubbed) {
    // ScrubbedTraceInput
    return {
      masked: true,
      hash: scrubbed.contentHash,
      bytes: scrubbed.totalBytes,
      reason: "user_opt_out",
    };
  }

  // ScrubbedTraceOutput
  return {
    masked: true,
    hash: scrubbed.contentHash ?? "none",
    bytes: 0,
    reason: "user_opt_out",
  };
}

/**
 * Apply user masking to tool I/O.
 */
export function applyToolMaskingPreference<
  T extends ScrubbedToolInput | ScrubbedToolOutput,
>(scrubbed: T, maskContent: boolean): T | MaskedPayload {
  if (!maskContent) {
    return scrubbed;
  }

  if ("argHash" in scrubbed) {
    return {
      masked: true,
      hash: scrubbed.argHash,
      bytes: scrubbed.argBytes,
      reason: "user_opt_out",
    };
  }

  return {
    masked: true,
    hash: scrubbed.resultHash,
    bytes: scrubbed.resultBytes,
    reason: "user_opt_out",
  };
}

// ============================================================================
// TraceId Validation
// ============================================================================

/** Regex for valid 32-hex OTel trace ID */
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;

/**
 * Validate that traceId is a valid 32-hex OTel trace ID.
 */
export function isValidOtelTraceId(traceId: string | undefined): boolean {
  return traceId != null && TRACE_ID_REGEX.test(traceId);
}

/**
 * Truncate sessionId to Langfuse limit (200 chars).
 */
export function truncateSessionId(
  sessionId: string | undefined
): string | undefined {
  if (!sessionId) return undefined;
  return sessionId.length <= 200 ? sessionId : sessionId.slice(0, 200);
}
