// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * OpenCode 1.x entry point for session cognition (story.0001). OpenCode loads
 * opencode.json `instructions` (.cogni/.cognition-cache.md) after plugins
 * initialize, so refreshing the cache here makes each session start from a
 * bundle fetched for it. The shared loader keeps the last complete cache when
 * the hub is down or answers with an incomplete bundle.
 */
export const CogniCognition = async ({ $, worktree }) => {
	await $`bash ${worktree}/scripts/agent/session-cognition.sh --refresh`
		.quiet()
		.nothrow();
	return {};
};
