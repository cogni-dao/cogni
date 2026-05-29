// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/gates/shape`
 * Purpose: Structural shape gate — enforces id slug pattern, title length, content non-empty, tag count. The knowledge equivalent of commitlint, applied uniformly at every write boundary.
 * Scope: Pure per-field validation + canonical trimming on success. Does not perform I/O, hit external systems, or cross-validate fields against each other (cross-field checks live in sibling gates).
 * Invariants:
 *   - SHAPE_IS_THE_FLOOR: every accepted write satisfies these constraints uniformly across HTTP and tool entry points.
 * Side-effects: none
 * Links: work/projects/proj.knowledge-syntropy.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  GateError,
  GateResult,
  KnowledgeGate,
  KnowledgeWriteCandidate,
} from "./types.js";

/**
 * Slug pattern: kebab-case, **1–4 dash-separated segments**, ≤40 chars total,
 * `[a-z0-9]` tokens joined by single `-`. Forbids leading/trailing dashes,
 * consecutive dashes, uppercase, underscores, colons, dots. Compact +
 * grep-friendly + URL-safe.
 *
 * Why 4 segments max: long slugs let authors pack multiple concepts into one
 * id (e.g. `meta-contribution-branch-flow-merkle-dag-v1` smuggles 6 ideas).
 * Capping segments forces atomic naming; if you need more concepts, you need
 * a sibling atom + a citation edge, not a longer id.
 */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+){0,3}$/;
const SLUG_MIN_LEN = 2;
const SLUG_MAX_LEN = 40;

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
      if (input.id.length < SLUG_MIN_LEN || input.id.length > SLUG_MAX_LEN) {
        errors.push({
          gate: "shape",
          field: "id",
          code: "slug_length",
          message: `id must be ${SLUG_MIN_LEN}–${SLUG_MAX_LEN} chars (got ${input.id.length})`,
        });
      } else if (!SLUG_RE.test(input.id)) {
        errors.push({
          gate: "shape",
          field: "id",
          code: "slug_invalid",
          message:
            "id must be a kebab-slug with 1–4 dash-segments, lowercase [a-z0-9] only (e.g. `fed-rate-base-rate`). Pack additional concepts into sibling atoms + citations, not into the id.",
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
    } else if (/ · | — | -- /.test(title)) {
      // Reject section separators that smuggle two concepts into one atom.
      // Examples we've seen: "Contribution Branch Flow · Merkle DAG",
      // "Knowledge Block Visuals · Rendered Primitive Inventory",
      // "Open-Source AI Tooling vs Cogni — Multi-Tenant Capability Matrix".
      // If you need two concepts, write two atoms + a citation edge.
      errors.push({
        gate: "shape",
        field: "title",
        code: "title_section_separator",
        message:
          "title must not contain ` · `, ` — `, or ` -- ` as a section separator. One atomic claim per entry — split into sibling atoms if you have two concepts.",
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
