// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/plan-database-recovery-host-rebind`
 * Purpose: Plan an explicitly reviewed hostname-only recovery-binding repair.
 * Scope: Pure validation and private stdin/stdout; no native or secret-store IO.
 * Invariants: Ordinary sealing is unchanged; only source-approved plans may rebind;
 * native cluster, credentials and sibling bindings survive; caller performs CAS.
 * Side-effects: IO (CLI only)
 * Links: scripts/ci/secret-materialize.sh
 * @internal
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  recoveryBindingErrorCategory,
  recoveryBindingInputSchema,
  sealRecoveryBinding,
} from "./materialize-database-recovery-binding";

const authorizationSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("unarmed"), appliedMigrationReceipt: z.null() })
    .strict(),
  z
    .object({
      state: z.literal("armed"),
      // A reviewed source reference to actual applied migration/fencing evidence.
      // An arbitrary URL or equality observation is not itself that evidence.
      appliedMigrationReceipt: z
        .object({
          reference: z.string().url(),
          oldSourceFenced: z.literal(true),
        })
        .strict(),
    })
    .strict(),
]);
const planSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,100}$/),
    nodeId: z.string().uuid(),
    nodeSlug: z.string(),
    environment: z.enum(["candidate-a", "preview", "production"]),
    oldHost: z.string().refine(isIPv4),
    newHost: z.string().refine(isIPv4),
    machineId: z.string().regex(/^[0-9a-f]{32}$/),
    authorization: authorizationSchema,
  })
  .strict();
export type HostRebindPlan = z.infer<typeof planSchema>;

// Runtime authority is reviewed source, never an environment flag or CLI plan.
// UNARMED: owner 08:00 identity equalities do not prove the old source is fenced.
// Arm only in a separately reviewed source change with actual applied evidence.
export const reviewedHostRebindPlans: readonly HostRebindPlan[] = [
  {
    id: "operator-production-32gb-rehost-20261021",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    nodeSlug: "operator",
    environment: "production",
    oldHost: "5.199.162.44",
    newHost: "84.32.244.43",
    machineId: "9e8bb1a5190947e7b7a29f5d1a0d4f71",
    authorization: { state: "unarmed", appliedMigrationReceipt: null },
  },
];

class HostRebindRejection extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
function requireProof(condition: boolean, category: string): asserts condition {
  if (!condition) throw new HostRebindRejection(category);
}

export function planRecoveryBinding(
  raw: unknown,
  plans: readonly HostRebindPlan[] = reviewedHostRebindPlans,
  now = Date.now()
) {
  const input = recoveryBindingInputSchema.parse(raw);
  try {
    return { bindings: sealRecoveryBinding(input), rebind: null };
  } catch (error) {
    // Preserve every ordinary rejection. Only an otherwise matching old host is
    // eligible for a source-reviewed plan; never generalize this to an override.
    if (recoveryBindingErrorCategory(error) !== "prior_host") throw error;
  }
  const matches = plans
    .map((p) => planSchema.parse(p))
    .filter(
      (p) =>
        p.nodeId === input.nodeId &&
        p.nodeSlug === input.nodeSlug &&
        p.environment === input.environment &&
        p.newHost === input.expectedHost
    );
  requireProof(matches.length === 1, "rebind_plan_scope");
  const plan = matches[0];
  requireProof(plan !== undefined, "rebind_plan_scope");
  requireProof(plan.authorization.state === "armed", "rebind_plan_unarmed");
  // Narrow the discriminated union for the safe receipt below.
  if (plan.authorization.state !== "armed")
    throw new HostRebindRejection("rebind_plan_unarmed");
  requireProof(
    plan.oldHost !== plan.newHost && input.machineId === plan.machineId,
    "rebind_plan_identity"
  );
  const observedAt = Date.parse(input.observation.observedAt);
  requireProof(
    observedAt >= now - 120_000 && observedAt <= now + 5_000,
    "rebind_native_stale"
  );
  const prior = input.existingBindings.find(
    (b) => b.nodeId === input.nodeId && b.environment === input.environment
  );
  requireProof(prior !== undefined, "rebind_prior_missing");
  const oldUrl = new URL(prior.dsn);
  requireProof(oldUrl.hostname === plan.oldHost, "rebind_prior_host");
  oldUrl.hostname = plan.newHost;
  // Exact normalized URL equality retains password, protocol, port, role, DB,
  // query and fragment. No credentials are accepted from the source plan.
  requireProof(
    oldUrl.href === new URL(input.dsn).href,
    "rebind_credentials_or_url"
  );
  // Run ALL existing guards again, changing only the explicitly authorized host.
  // In particular prior PG identity must equal both local and TCP identities.
  const bindings = sealRecoveryBinding({
    ...input,
    existingBindings: input.existingBindings.map((b) =>
      b === prior ? { ...b, dsn: input.dsn } : b
    ),
  });
  return {
    bindings,
    rebind: {
      planId: plan.id,
      planSha256: createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex"),
      migrationReceipt: plan.authorization.appliedMigrationReceipt.reference,
      nodeId: input.nodeId,
      environment: input.environment,
      identityPreserved: true,
      credentialsPreserved: true,
      siblingsPreserved: true,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    // No arguments/overrides: only the reviewed plans above are runtime authority.
    requireProof(process.argv.length === 2, "rebind_cli_arguments");
    process.stdout.write(
      JSON.stringify(planRecoveryBinding(JSON.parse(readFileSync(0, "utf8"))))
    );
  } catch (error) {
    const category =
      error instanceof HostRebindRejection
        ? error.category
        : recoveryBindingErrorCategory(error);
    process.stderr.write(`recovery binding receipt rejected: ${category}\n`);
    process.exitCode = 1;
  }
}
