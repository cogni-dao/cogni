// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/observability-temporal`
 * Purpose: Resolve, authorize and prepare one finite local diagnostic before native I/O.
 * Scope: Orchestration over injected read-only seams; strict env-only public input.
 * Invariants: Every preparation await checks cancellation; no denied or wrong-env native read.
 * Side-effects: IO through injected ports only.
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import {
  diagnosticEnvSchema,
  type LedgerDiagnosticBinding,
  type LedgerDiagnosticV1,
  type TemporalLedgerDiagnosticPort,
} from "@cogni/scheduler-core";
export interface DiagnosticNode {
  nodeId: string;
  slug: string;
  status: string;
  deployEnvs: readonly string[];
  activityEnv: string;
}
export class DiagnosticInputError extends Error {
  constructor(readonly code: "invalid_query" | "invalid_env") {
    super(code);
  }
}
export function parseLedgerDiagnosticQuery(params: URLSearchParams) {
  if (
    params.size !== 1 ||
    params.getAll("env").length !== 1 ||
    [...params.keys()].some((key) => key !== "env")
  )
    throw new DiagnosticInputError("invalid_query");
  const env = diagnosticEnvSchema.safeParse(params.get("env"));
  if (!env.success) throw new DiagnosticInputError("invalid_env");
  return env.data;
}
export async function readLedgerDiagnostic(
  input: {
    ref: string;
    actorId: string;
    env: "candidate-a" | "preview" | "production";
    signal: AbortSignal;
    deadline: number;
    onNodeResolved?: (nodeId: string) => void;
    onAttempt?: () => void;
  },
  deps: {
    check(): void;
    lookup(ref: string): Promise<DiagnosticNode>;
    authorize(actorId: string, nodeId: string): Promise<void>;
    bind(
      node: DiagnosticNode,
      env: typeof input.env
    ): Promise<LedgerDiagnosticBinding | LedgerDiagnosticV1>;
    finish(): void;
    reader: TemporalLedgerDiagnosticPort;
  }
): Promise<LedgerDiagnosticV1> {
  deps.check();
  const node = await deps.lookup(input.ref);
  input.onNodeResolved?.(node.nodeId);
  deps.check();
  await deps.authorize(input.actorId, node.nodeId);
  deps.check();
  const binding = await deps.bind(node, input.env);
  deps.check();
  deps.finish();
  input.signal.throwIfAborted();
  if ("schemaVersion" in binding) return binding;
  return deps.reader.read(binding, {
    signal: input.signal,
    deadline: input.deadline,
    ...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
  });
}
