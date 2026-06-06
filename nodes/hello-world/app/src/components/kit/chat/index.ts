// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/chat`
 * Purpose: Chat UI component exports.
 * Scope: Re-exports kit-level chat components. Does not implement chat business logic.
 * Invariants: Stable export surface for chat UI components
 * Side-effects: none
 * Links: Wraps vendor/assistant-ui components for governance
 * @public
 */

export { ComposerVoiceInput } from "./ComposerVoiceInput";
export { Thread, type ThreadProps } from "./Thread";
