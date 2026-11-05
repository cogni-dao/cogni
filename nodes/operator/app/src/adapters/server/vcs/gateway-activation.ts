// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@adapters/server/vcs/gateway-activation`
 * Purpose: Persist immutable gateway intents and observe the existing native runner.
 * Scope: Canonical infrastructure custodian only; no host access or provider bytes.
 * Invariants: Signed App intent before dispatch; same UUID selects the same source;
 *   bounded complete discovery; workflow transport and implementation stay distinct.
 * Side-effects: GitHub App Git/Contents writes and fixed workflow dispatch.
 * Links: bug.5570, docs/spec/cicd-platform-boundary.md
 * @internal
 */
import {
  type GatewayEnvironment,
  type GatewayIntent,
  GatewayIntentSchema,
  GatewayObservationSchema,
  type GatewayOperation,
  GatewayOperationIdSchema,
  GatewayOperationSchema,
  gatewayIntentRef,
} from "@cogni/operator-gateway-activation";
import type { Octokit } from "@octokit/core";
import { unzipSync } from "fflate";
import { z } from "zod";

const PATH = ".cogni/gateway-activation-intent.json";
const WORKFLOW = "candidate-flight-infra.yml";
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const branchSchema = z.object({
  protected: z.literal(true),
  commit: z.object({ sha: Sha }),
});
const refSchema = z.object({
  object: z.object({ type: z.literal("commit"), sha: Sha }),
});
const contentsSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string().max(32768),
});
const commitSchema = z.object({
  sha: Sha,
  author: z.object({ id: z.number().int(), login: z.string() }),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.iso.datetime({ offset: true }) }),
    verification: z.object({ verified: z.literal(true) }),
  }),
});
const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  event: z.string(),
  path: z.string(),
  display_title: z.string(),
  head_sha: Sha,
  status: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  actor: z.object({ id: z.number().int() }),
  html_url: z.url(),
});
type Run = z.infer<typeof runSchema>;
export interface GatewayCustodianConfig {
  hostingEnv?: string | undefined;
  fleetControlEnv?: string | undefined;
  parentOwner?: string | undefined;
  parentRepo?: string | undefined;
}
export interface GatewayOperationInput {
  parentOwner: string;
  parentRepo: string;
  operationId: string;
}
export interface GatewayActivationInput extends GatewayOperationInput {
  env: GatewayEnvironment;
  slug: "operator";
  target: "litellm-provider-key";
}
function refuse(code: string, status = 409): never {
  throw Object.assign(new Error(code), { code, status });
}
/** Environment labels cannot give a test App canonical infrastructure authority. */
export function assertGatewayCustodian(
  input: GatewayOperationInput,
  config: GatewayCustodianConfig
) {
  GatewayOperationIdSchema.parse(input.operationId);
  if (
    config.hostingEnv !== "production" ||
    config.fleetControlEnv !== "production" ||
    config.parentOwner?.toLowerCase() !== "cogni-dao" ||
    config.parentRepo?.toLowerCase() !== "cogni" ||
    input.parentOwner !== config.parentOwner ||
    input.parentRepo !== config.parentRepo
  ) {
    refuse("gateway_canonical_custodian_required", 403);
  }
}

export class GithubGatewayActivation {
  constructor(
    private readonly client: Octokit,
    private readonly input: GatewayOperationInput,
    private readonly bot: { id: number; login: string },
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async request(route: string, params: Record<string, unknown> = {}) {
    return (
      await this.client.request(route, {
        owner: this.input.parentOwner,
        repo: this.input.parentRepo,
        ...params,
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
        request: { signal: AbortSignal.timeout(15000) },
      })
    ).data as unknown;
  }

  private async main(): Promise<string> {
    return branchSchema.parse(
      await this.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        branch: "main",
      })
    ).commit.sha;
  }

  private async readAt(sha: string) {
    const commit = commitSchema.parse(
      await this.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        ref: sha,
      })
    );
    if (
      commit.author.id !== this.bot.id ||
      commit.author.login !== this.bot.login ||
      commit.commit.message !==
        `chore(gateway): persist activation ${this.input.operationId}`
    ) {
      refuse("gateway_intent_not_signed_by_operator");
    }
    const file = contentsSchema.parse(
      await this.request("GET /repos/{owner}/{repo}/contents/{path}", {
        path: PATH,
        ref: sha,
      })
    );
    const intent = GatewayIntentSchema.parse(
      JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
    );
    if (
      intent.operationId !== this.input.operationId ||
      intent.custodian.owner !== this.input.parentOwner ||
      intent.custodian.repo !== this.input.parentRepo ||
      intent.custodian.controlEnv !== "production"
    )
      refuse("gateway_intent_identity_conflict");
    return { intent, createdAt: commit.commit.committer.date };
  }

  private async readIntent() {
    const reference = refSchema.parse(
      await this.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ref: gatewayIntentRef(this.input.operationId),
      })
    );
    return this.readAt(reference.object.sha);
  }

  private async ensureIntent(env: GatewayEnvironment) {
    try {
      const existing = await this.readIntent();
      if (existing.intent.env !== env) refuse("gateway_idempotency_conflict");
      return existing;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    const implementationSha = await this.main();
    const intent = GatewayIntentSchema.parse({
      version: 1,
      operationId: this.input.operationId,
      target: "litellm-provider-key",
      env,
      custodian: {
        owner: this.input.parentOwner,
        repo: this.input.parentRepo,
        controlEnv: "production",
      },
      implementationSha,
      protocolVersion: 1,
      bindingRef: `cogni/${env}/operator/OPENROUTER_API_KEY`,
    });
    // Contents commits are signed by GitHub for this App. Git-data commits allow
    // forged author emails and cannot establish this provenance. The temporary
    // branch has a stable identity and is never a runtime desired-state ref.
    const branch = `cogni-gateway-intent/${this.input.operationId}`;
    try {
      await this.request("POST /repos/{owner}/{repo}/git/refs", {
        ref: `refs/heads/${branch}`,
        sha: implementationSha,
      });
    } catch (error) {
      // Read after a conflict or unknown outcome before attempting another write.
      const reference = refSchema.parse(
        await this.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ref: `heads/${branch}`,
        })
      );
      if (reference.object.sha !== implementationSha) {
        const previous = await this.readAt(reference.object.sha);
        if (previous.intent.env !== env) refuse("gateway_idempotency_conflict");
      } else if (
        (error as { status?: number }).status !== 422 &&
        (error as { status?: number }).status === 403
      ) {
        throw error;
      }
    }
    let selected: string;
    const reference = refSchema.parse(
      await this.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ref: `heads/${branch}`,
      })
    );
    if (reference.object.sha === implementationSha) {
      try {
        const data = z.object({ commit: z.object({ sha: Sha }) }).parse(
          await this.request("PUT /repos/{owner}/{repo}/contents/{path}", {
            path: PATH,
            branch,
            message: `chore(gateway): persist activation ${this.input.operationId}`,
            content: Buffer.from(`${JSON.stringify(intent)}\n`).toString(
              "base64"
            ),
          })
        );
        selected = data.commit.sha;
      } catch {
        selected = refSchema.parse(
          await this.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            ref: `heads/${branch}`,
          })
        ).object.sha;
      }
    } else selected = reference.object.sha;
    const persisted = await this.readAt(selected);
    if (persisted.intent.env !== env) refuse("gateway_idempotency_conflict");
    try {
      await this.request("POST /repos/{owner}/{repo}/git/refs", {
        ref: `refs/${gatewayIntentRef(this.input.operationId)}`,
        sha: selected,
      });
    } catch {
      // An immutable ref may already have committed; never replace it.
    }
    const result = await this.readIntent();
    if (result.intent.env !== env) refuse("gateway_idempotency_conflict");
    // Ref cleanup is not required for dispatch correctness. A lost cleanup can
    // leave only a signed, value-free temporary branch, never a host effect.
    try {
      await this.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        ref: `heads/${branch}`,
      });
    } catch {
      /* retained for reconciliation */
    }
    return result;
  }

  private async discover(intent: GatewayIntent, createdAt: string) {
    const runs: Run[] = [];
    const ids = new Set<number>();
    let count: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const data = z
        .object({
          total_count: z.number().int().nonnegative(),
          workflow_runs: z.array(runSchema).max(100),
        })
        .parse(
          await this.request(
            "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
            {
              workflow_id: WORKFLOW,
              event: "workflow_dispatch",
              created: `>=${createdAt}`,
              per_page: 100,
              page,
            }
          )
        );
      if (
        data.total_count > 1000 ||
        (count !== undefined && count !== data.total_count)
      )
        return { complete: false, runs: [] };
      count = data.total_count;
      for (const run of data.workflow_runs) {
        if (ids.has(run.id)) return { complete: false, runs: [] };
        ids.add(run.id);
        const prefix = `Gateway ${intent.operationId} ${intent.env} ${intent.implementationSha} `;
        if (
          run.event === "workflow_dispatch" &&
          run.actor.id === this.bot.id &&
          run.path === `.github/workflows/${WORKFLOW}` &&
          run.display_title === prefix + run.head_sha &&
          Date.parse(run.created_at) >= Date.parse(createdAt)
        )
          runs.push(run);
      }
      if (ids.size === count)
        return { complete: true, runs: runs.sort((a, b) => b.id - a.id) };
      if (data.workflow_runs.length < 100) return { complete: false, runs: [] };
    }
    return { complete: false, runs: [] };
  }

  private async receipt(run: Run, intent: GatewayIntent) {
    const list = z
      .object({
        total_count: z.number().int().nonnegative(),
        artifacts: z
          .array(
            z.object({
              id: z.number().int().positive(),
              name: z.string(),
              expired: z.boolean(),
              size_in_bytes: z.number().int(),
            })
          )
          .max(100),
      })
      .parse(
        await this.request(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
          { run_id: run.id, per_page: 100 }
        )
      );
    if (list.total_count > 100 || list.total_count !== list.artifacts.length)
      return undefined;
    const matches = list.artifacts.filter(
      (a) =>
        a.name === `gateway-receipt-${intent.operationId}-${run.run_attempt}` &&
        !a.expired
    );
    if (
      matches.length !== 1 ||
      !matches[0] ||
      matches[0].size_in_bytes > 1048576
    )
      return undefined;
    const raw = await this.request(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      { artifact_id: matches[0].id, archive_format: "zip" }
    );
    if (!(raw instanceof ArrayBuffer) || raw.byteLength > 1048576)
      return undefined;
    const entries = unzipSync(new Uint8Array(raw), {
      filter: (f) =>
        f.name === "gateway-receipt.json" && f.originalSize <= 65536,
    });
    const bytes = entries["gateway-receipt.json"];
    if (!bytes || bytes.length > 65536) return undefined;
    const value = z
      .strictObject({
        version: z.literal(1),
        intent: GatewayIntentSchema,
        transportSha: Sha,
        runId: z.number().int().positive(),
        runAttempt: z.number().int().positive(),
        observation: GatewayObservationSchema,
      })
      .parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (
      JSON.stringify(value.intent) !== JSON.stringify(intent) ||
      value.transportSha !== run.head_sha ||
      value.runId !== run.id ||
      value.runAttempt !== run.run_attempt ||
      value.observation.operationId !== intent.operationId
    )
      return undefined;
    return value.observation;
  }

  async status(): Promise<GatewayOperation> {
    const { intent, createdAt } = await this.readIntent();
    const result: GatewayOperation = {
      target: intent.target,
      env: intent.env,
      sourceSha: intent.implementationSha,
      operationId: intent.operationId,
      intent,
      intentCreatedAt: createdAt,
      status: "unknown",
      observedAt: this.clock().toISOString(),
      currentState: "unobserved",
    };
    const discovery = await this.discover(intent, createdAt);
    const run = discovery.complete ? discovery.runs[0] : undefined;
    if (!run) return GatewayOperationSchema.parse(result);
    result.runId = run.id;
    result.runUrl = run.html_url;
    result.transportSha = run.head_sha;
    if (run.status !== "completed") result.status = "running";
    else {
      try {
        const historicalReceipt = await this.receipt(run, intent);
        if (historicalReceipt) {
          result.historicalReceipt = historicalReceipt;
          if (
            ["activated", "rolled_back", "conflict"].includes(
              historicalReceipt.phase
            )
          ) {
            result.status = historicalReceipt.phase as
              | "activated"
              | "rolled_back"
              | "conflict";
          }
        }
      } catch {
        /* An incomplete/expired artifact is unknown, never a success claim. */
      }
    }
    return GatewayOperationSchema.parse(result);
  }

  async submit(env: GatewayEnvironment): Promise<GatewayOperation> {
    const selected = await this.ensureIntent(env);
    const discovery = await this.discover(selected.intent, selected.createdAt);
    if (
      !discovery.complete ||
      discovery.runs.some((r) => r.status !== "completed")
    )
      return this.status();
    const transportSha = await this.main();
    const comparison = z
      .object({ status: z.enum(["ahead", "behind", "diverged", "identical"]) })
      .parse(
        await this.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          basehead: `${selected.intent.implementationSha}...${transportSha}`,
        })
      );
    if (!["ahead", "identical"].includes(comparison.status))
      refuse("gateway_source_not_on_trusted_main");
    try {
      await this.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          workflow_id: WORKFLOW,
          ref: "main",
          inputs: {
            operation: "gateway-activation",
            environment: env,
            operation_id: selected.intent.operationId,
            implementation_sha: selected.intent.implementationSha,
            transport_sha: transportSha,
          },
        }
      );
    } catch {
      // Native acceptance is uncertain. The intent remains discoverable and the
      // same UUID can resume; a new identity is never minted here.
      return this.status();
    }
    const observed = await this.status();
    return observed.status === "unknown"
      ? GatewayOperationSchema.parse({
          ...observed,
          status: "submitted",
          transportSha,
        })
      : observed;
  }
}
