// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/knowledge-mirror`
 * Purpose: Resolve the optional DoltHub mirror remote from repo-spec knowledge config.
 * Scope: Pure runtime wiring helper; no env fallback or network IO.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md
 * @internal
 */

import type { KnowledgeConfig } from "@/shared/config";

export function resolveKnowledgeMirrorRemoteUrl(
  knowledge: KnowledgeConfig | undefined
): string | undefined {
  return knowledge?.remote.url;
}
