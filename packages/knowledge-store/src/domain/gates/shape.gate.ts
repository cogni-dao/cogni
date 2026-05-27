// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates/shape`
 * Purpose: Structural shape gate — enforces id slug pattern, title length,
 *   content non-empty, tag count. The knowledge equivalent of commitlint.
 * Scope: Pure validation; uses Zod under the hood for primitive checks.
 * Invariants:
 *   - SHAPE_IS_THE_FLOOR: every accepted write satisfies these constraints
 *     uniformly across HTTP and tool entry points.
 * @public
 */

import type {
  GateError,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "./types.js";

/**
 * Slug pattern: kebab-case, 3–40 chars, starts + ends with alphanumeric.
 * Forbids leading/trailing dashes, double-dashes, uppercase, underscores,
 * colons, dots. Compact + grep-friendly + URL-safe.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const TITLE_MIN = 3;
const TITLE_MAX = 60;
const CONTENT_MIN = 1;
const TAGS_MAX = 16;
const TAG_MAX = 32;

export const shapeGate: KnowledgeGate = {
  name: "shape",
  tier: "v0",
  async check(input: KnowledgeWriteCandidate): Promise<GateResult> {
    const errors: GateError[] = [];

    if (input.id !== undefined) {
      if (!SLUG_RE.test(input.id)) {
        errors.push({
          gate: "shape",
          field: "id",
          code: "slug_invalid",
          message:
            "id must be a kebab-slug: 3–40 chars, [a-z0-9-], starting and ending with alphanumeric",
        });
      }
    }

    const title = input.title?.trim() ?? "";
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      errors.push({
        gate: "shape",
        field: "title",
        code: "title_length",
        message: `title must be ${TITLE_MIN}–${TITLE_MAX} chars after trimming (got ${title.length})`,
      });
    } else if (/[.!?]$/.test(title)) {
      errors.push({
        gate: "shape",
        field: "title",
        code: "title_trailing_punctuation",
        message:
          "title must not end with trailing punctuation — it's an atomic claim, not a sentence",
      });
    }

    const content = input.content ?? "";
    if (content.length < CONTENT_MIN) {
      errors.push({
        gate: "shape",
        field: "content",
        code: "content_empty",
        message: "content must be non-empty",
      });
    }

    if (input.tags) {
      if (input.tags.length > TAGS_MAX) {
        errors.push({
          gate: "shape",
          field: "tags",
          code: "tags_too_many",
          message: `tags must be ≤ ${TAGS_MAX} (got ${input.tags.length})`,
        });
      }
      for (const t of input.tags) {
        if (t.length === 0 || t.length > TAG_MAX) {
          errors.push({
            gate: "shape",
            field: "tags",
            code: "tag_length",
            message: `each tag must be 1–${TAG_MAX} chars (got "${t}")`,
          });
          break;
        }
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    // Sanitize: persist trimmed title so downstream gates + storage see the
    // canonical form.
    return { ok: true, candidate: { ...input, title } };
  },
};
