// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Supervised DEV experiment only. No flight API, deploy state, or production authority. */
import { createHash } from "node:crypto";
import type { ProvisionOutput, ProvisionSpec } from "@cogni/ai-tools";
import { z } from "zod";

const digestImage = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/);
const service = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  image: digestImage,
  cpuUnits: z.number().positive().max(2),
  memoryMi: z.number().int().positive().max(2048),
  storageMi: z.number().int().positive().max(20480),
  env: z.record(z.string(), z.string()).optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  expose: z
    .array(
      z.strictObject({
        port: z.number().int().min(1).max(65535),
        as: z.number().int().min(1).max(65535),
        global: z.boolean(),
        hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
      })
    )
    .optional(),
});

export const DevPreviewConfigSchema = z
  .strictObject({
    requestId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    deadlineSeconds: z.number().int().min(30).max(600).default(600),
    useIngressAuthOrigin: z.boolean().default(false),
    allowedProviders: z
      .array(z.string().regex(/^akash1[0-9a-z]{38}$/))
      .min(1)
      .max(20)
      .optional(),
    pricing: z.strictObject({
      pricingDenom: z.literal("uakt"),
      pricingAmount: z.number().positive().max(10000),
    }),
    spec: z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      services: z.array(service).length(1),
      placement: z
        .strictObject({
          requiredCountryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
        })
        .optional(),
    }),
  })
  .superRefine((config, ctx) => {
    if (
      new Set(config.spec.services.map((s) => s.name)).size !==
      config.spec.services.length
    ) {
      ctx.addIssue({ code: "custom", message: "Service names must be unique" });
    }
  });
export type DevPreviewConfig = z.infer<typeof DevPreviewConfigSchema>;

export const DevPreviewRecordSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string(),
  accountId: z.string(),
  sourceSha: z.string(),
  imageDigests: z.array(z.string()),
  requestHash: z.string(),
  startedAt: z.string().datetime(),
  deadlineAt: z.string().datetime(),
  phase: z.enum([
    "reserved",
    "allocating",
    "ready",
    "closing",
    "closed",
    "cleanup_pending",
  ]),
  cursor: z.string().optional(),
  allocationSubmittedAt: z.string().optional(),
  externalName: z.string().optional(),
  endpoints: z.array(z.string()).optional(),
  authOrigin: z.string().optional(),
  originUpdateSubmittedAt: z.string().optional(),
  closedAt: z.string().optional(),
  failureCode: z.string().optional(),
  cost: z.unknown().optional(),
});
export type DevPreviewRecord = z.infer<typeof DevPreviewRecordSchema>;

export interface DevPreviewProvider {
  allocationCursor(): Promise<string>;
  provisionWithAllocation(
    input: {
      env: string;
      spec: ProvisionSpec;
      expectedSourceSha: string;
      idempotencyKey: string;
    },
    allocated: (output: ProvisionOutput) => Promise<void>
  ): Promise<ProvisionOutput>;
  findAllocationSince(
    cursor: string
  ): Promise<
    | { outcome: "settled" }
    | { outcome: "ambiguous"; dseqs: readonly string[] }
    | { outcome: "adopted"; output: ProvisionOutput }
  >;
  release(input: { leaseId: string }): Promise<void>;
  status(input: { leaseId: string }): Promise<ProvisionOutput>;
}

export interface DevPreviewDeps {
  provider: DevPreviewProvider;
  save(record: DevPreviewRecord): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  releaseRequested(): Promise<boolean>;
  emit(record: DevPreviewRecord): void;
  captureCost?(leaseId: string): Promise<unknown>;
  prepareAuthenticatedOrigin?(
    output: ProvisionOutput,
    spec: ProvisionSpec
  ): Promise<{ output: ProvisionOutput; origin: string }>;
}

export class DevPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Only allowlisted classifications leave this runner; provider errors may echo SDL secrets. */
export function safeFailure(error: unknown): string {
  if (error instanceof DevPreviewError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code)
    ? code
    : "EXPERIMENT_FAILED";
}

export function newDevPreviewRecord(
  config: DevPreviewConfig,
  accountId: string,
  now: number
): DevPreviewRecord {
  return {
    version: 1,
    requestId: config.requestId,
    accountId,
    sourceSha: config.sourceSha,
    imageDigests: config.spec.services.map((s) => s.image),
    // Bind secret-bearing config by hash; NEVER persist the spec or environment values.
    requestHash: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex"),
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + config.deadlineSeconds * 1000).toISOString(),
    phase: "reserved",
  };
}

/** Zod optional properties include undefined; omit them on the exact-optional port. */
function provisionSpec(config: DevPreviewConfig): ProvisionSpec {
  return {
    name: config.spec.name,
    services: config.spec.services.map((s) => ({
      name: s.name,
      image: s.image,
      cpuUnits: s.cpuUnits,
      memoryMi: s.memoryMi,
      storageMi: s.storageMi,
      ...(s.env ? { env: s.env } : {}),
      ...(s.command ? { command: s.command } : {}),
      ...(s.args ? { args: s.args } : {}),
      ...(s.expose
        ? {
            expose: s.expose.map((e) => ({
              port: e.port,
              as: e.as,
              global: e.global,
              ...(e.hosts ? { hosts: e.hosts } : {}),
            })),
          }
        : {}),
    })),
    ...(config.spec.placement ? { placement: config.spec.placement } : {}),
  };
}

async function saveCost(
  record: DevPreviewRecord,
  deps: DevPreviewDeps
): Promise<void> {
  if (!record.externalName || !deps.captureCost) return;
  try {
    record.cost = await deps.captureCost(record.externalName);
    await deps.save(record);
  } catch {
    /* Missing cost detail never prevents lease closure. */
  }
}

/** DELETE acknowledgment is never closure. Positive readback is required. */
export async function closeDevPreview(
  record: DevPreviewRecord,
  deps: DevPreviewDeps
): Promise<void> {
  if (record.phase === "closed") return;
  record.phase = "closing";
  await deps.save(record);
  try {
    if (!record.externalName && record.allocationSubmittedAt) {
      if (!record.cursor)
        throw new DevPreviewError("MISSING_ALLOCATION_CURSOR");
      const result = await deps.provider.findAllocationSince(record.cursor);
      if (result.outcome !== "adopted") {
        // A timed-out POST can still land later. Preserve the cursor and refuse any new spend.
        throw new DevPreviewError(
          result.outcome === "ambiguous"
            ? "ALLOCATION_AMBIGUOUS"
            : "CREATE_OUTCOME_UNKNOWN"
        );
      }
      record.externalName = result.output.leaseId;
      await deps.save(record);
    }
    if (record.externalName) {
      await saveCost(record, deps);
      const until = deps.now() + 120000;
      let closed = false;
      while (deps.now() < until) {
        try {
          await deps.provider.release({ leaseId: record.externalName });
        } catch {
          /* Observe anyway. */
        }
        try {
          const observed = await deps.provider.status({
            leaseId: record.externalName,
          });
          if (observed.state === "closed") {
            closed = true;
            break;
          }
        } catch {
          /* Unknown/read failure is not closure. */
        }
        await deps.sleep(3000);
      }
      if (!closed) throw new DevPreviewError("CLOSURE_UNVERIFIED");
      await saveCost(record, deps);
    }
    record.phase = "closed";
    record.closedAt = new Date(deps.now()).toISOString();
    await deps.save(record);
    deps.emit(record);
  } catch (error) {
    record.phase = "cleanup_pending";
    record.failureCode = safeFailure(error);
    await deps.save(record);
    deps.emit(record);
    throw error;
  }
}

/** One supervised allocation; holds ready URL for independent SIWE proof, then closes. */
export async function runDevPreview(
  config: DevPreviewConfig,
  record: DevPreviewRecord,
  deps: DevPreviewDeps
): Promise<void> {
  await deps.save(record); // Request identity exists before ANY allocation-related IO.
  let failure: unknown;
  try {
    if (
      deps.now() >= Date.parse(record.deadlineAt) ||
      (await deps.releaseRequested())
    ) {
      throw new DevPreviewError("REQUEST_EXPIRED_OR_RELEASED");
    }
    record.cursor = await deps.provider.allocationCursor();
    record.phase = "allocating";
    await deps.save(record);
    let output = await deps.provider.provisionWithAllocation(
      {
        env: "dev-probe",
        spec: provisionSpec(config),
        expectedSourceSha: config.sourceSha,
        idempotencyKey: config.requestId,
      },
      async (allocated) => {
        record.externalName = allocated.leaseId;
        await deps.save(record); // Adapter calls this BEFORE bids or lease submission.
      }
    );
    record.externalName = output.leaseId;
    if (config.useIngressAuthOrigin) {
      if (!deps.prepareAuthenticatedOrigin)
        throw new DevPreviewError("AUTH_ORIGIN_PREPARER_REQUIRED");
      if (
        deps.now() >= Date.parse(record.deadlineAt) ||
        (await deps.releaseRequested())
      )
        throw new DevPreviewError("REQUEST_EXPIRED_OR_RELEASED");
      const prepared = await deps.prepareAuthenticatedOrigin(
        output,
        provisionSpec(config)
      );
      if (prepared.output.leaseId !== output.leaseId)
        throw new DevPreviewError("AUTH_ORIGIN_CHANGED_ALLOCATION");
      record.authOrigin = prepared.origin;
      output = prepared.output;
      if (
        deps.now() >= Date.parse(record.deadlineAt) ||
        (await deps.releaseRequested())
      )
        throw new DevPreviewError("REQUEST_EXPIRED_OR_RELEASED");
    }
    record.endpoints = [...(output.endpoints ?? [])];
    record.phase = "ready";
    await deps.save(record);
    await saveCost(record, deps);
    deps.emit(record);
    while (
      deps.now() < Date.parse(record.deadlineAt) &&
      !(await deps.releaseRequested())
    ) {
      await deps.sleep(
        Math.min(1000, Date.parse(record.deadlineAt) - deps.now())
      );
    }
  } catch (error) {
    failure = error;
    record.failureCode = safeFailure(error);
    await deps.save(record);
  } finally {
    await closeDevPreview(record, deps);
  }
  if (failure) throw failure;
}
