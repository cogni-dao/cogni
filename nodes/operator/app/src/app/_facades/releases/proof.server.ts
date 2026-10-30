// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import "server-only";
import { getPublicComputeProof } from "@/bootstrap/container";
export async function compareReleaseProof(body: string, signal: AbortSignal) {
  const service = await getPublicComputeProof();
  if (!service) return { status: 503, body: { code: "unavailable" } };
  return service.sample(body, signal);
}
