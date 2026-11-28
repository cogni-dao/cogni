// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
/** The shared component owns its rows, labels, and state. */
import {
  AgentAccessSection,
  useApprovalFragment,
} from "@cogni/knowledge-base-ui";

const endpoints = {
  roles: "/api/v1/admin/ai-access",
  preview: "/api/v1/admin/ai-access/preview",
} as const;
export function AiAccessClient() {
  const token = useApprovalFragment();
  return <AgentAccessSection endpoints={endpoints} token={token} />;
}
