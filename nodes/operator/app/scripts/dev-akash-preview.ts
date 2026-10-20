// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Supervised, opt-in DEV provider experiment. Existing adapter, never candidate/prod custody.
 * pnpm exec tsx --tsconfig nodes/operator/app/tsconfig.app.json nodes/operator/app/scripts/dev-akash-preview.ts --config .context/runtime.json
 * --release asks the active runner to close; --cleanup recovers outstanding receipts without creating.
 * State contains metadata only. Config/runtime env must remain gitignored and never be printed.
 * Config: requestId, sourceSha, pricing{pricingDenom:"uakt",pricingAmount},
 * spec{name,services:[{name,image:"...@sha256:...",cpuUnits,memoryMi,storageMi,env,expose}]},
 * optional deadlineSeconds<=600 and useIngressAuthOrigin (default false).
 * Optional allowedProviders passes public provider account pins to the existing adapter;
 * use only the reviewed providers already admitted by the shared test substrate firewall.
 * During ready hold, independently use the existing SIWE fixtures (siwe-helpers.ts /
 * nextauth-http-helpers.ts) to log in and GET/PATCH/read back /api/v1/users/me at authOrigin.
 * Readiness alone is not that authenticated proof. The origin option updates only NEXTAUTH_URL
 * and APP_BASE_URL on the existing lease, preserving its image and exact source SHA.
 * Release: same command with --release --request-id <id> (no config). Recovery: --cleanup.
 * During allocation/boot, release fences subsequent paid calls but waits for the bounded
 * in-flight adapter operation; it is not instant cancellation. SIGKILL/laptop sleep cannot
 * guarantee timely cleanup: resume --cleanup before any new experiment. Unknown create/close
 * stays cleanup_pending and blocks new allocation; a DELETE acknowledgment is not closure.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import {
  AkashComputeAdapter,
  type AkashComputeAdapterConfig,
  AkashComputeError,
} from "@/adapters/server/compute/akash-compute.adapter";
import { safeVersionProbeResult } from "@/adapters/server/compute/safe-version-probe";
import {
  closeDevPreview,
  DevPreviewConfigSchema,
  type DevPreviewDeps,
  DevPreviewError,
  type DevPreviewRecord,
  DevPreviewRecordSchema,
  newDevPreviewRecord,
  runDevPreview,
  safeFailure,
} from "./dev-akash-preview.lifecycle";

async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(resolve(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false
  );
}

async function lockWallet(path: string): Promise<() => Promise<void>> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A crashed runner's durable receipt is recovered only after proving its process is gone.
    const raw = await readFile(`${path}/pid`, "utf8").catch(() => "");
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0)
      throw new DevPreviewError("LOCK_OWNER_UNKNOWN");
    try {
      process.kill(pid, 0);
      throw new DevPreviewError("DEV_WALLET_LOCKED");
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
    }
    // Serialize stale reclamation. Without this gate a second reclaimer could rename
    // the first claimant's NEW live lock after both read the same stale PID.
    const reclaim = `${path}.reclaim`;
    await mkdir(reclaim, { mode: 0o700 });
    try {
      if ((await readFile(`${path}/pid`, "utf8")) !== raw)
        throw new DevPreviewError("DEV_WALLET_LOCKED");
      const stale = `${path}.stale-${process.pid}`;
      await rename(path, stale);
      await rm(stale, { recursive: true });
      await mkdir(path, { mode: 0o700 });
    } finally {
      await rm(reclaim, { recursive: true });
    }
  }
  await writeFile(`${path}/pid`, String(process.pid), { mode: 0o600 });
  return () => rm(path, { recursive: true });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "request-id": { type: "string" },
      help: { type: "boolean", default: false },
      cleanup: { type: "boolean", default: false },
      release: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "DEV only: --config <private runtime.json> | --release --request-id <id> | --cleanup\nOne app; <=2 CPU/2048 Mi; <=600 seconds. Metadata/lock: ~/.cogni/dev-akash-preview/<wallet hash>\n"
    );
    return;
  }
  const config = values.config
    ? DevPreviewConfigSchema.parse(
        JSON.parse(await readFile(values.config, "utf8"))
      )
    : undefined;
  if (!config && !values.cleanup && !values.release)
    throw new DevPreviewError("CONFIG_REQUIRED");
  loadEnv({ path: ".env.cogni", quiet: true });
  // biome-ignore lint/style/noProcessEnv: standalone DEV composition root; these are the ONLY accepted credentials.
  const apiKey = process.env.AKASH_PROBE_CONSOLE_API_KEY;
  // biome-ignore lint/style/noProcessEnv: public DEV wallet pin, never a candidate/prod fallback.
  const accountId = process.env.AKASH_PROBE_ACCOUNT_ID;
  if (!apiKey || !accountId || !/^akash1[a-z0-9]{20,}$/.test(accountId))
    throw new DevPreviewError("DEV_CREDENTIALS_REQUIRED");
  const walletHash = createHash("sha256")
    .update(accountId)
    .digest("hex")
    .slice(0, 20);
  // Fixed across worktrees and invocations: a caller cannot bypass the wallet lock via --state-dir.
  const stateDir = resolve(
    homedir(),
    ".cogni",
    "dev-akash-preview",
    walletHash
  );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const releasePath = (requestId: string) => `${stateDir}/${requestId}.release`;
  if (values.release) {
    const requestId = values["request-id"] ?? config?.requestId;
    if (!requestId || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId))
      throw new DevPreviewError("REQUEST_ID_REQUIRED");
    if (!(await exists(`${stateDir}/${requestId}.json`)))
      throw new DevPreviewError("REQUEST_NOT_FOUND");
    await durableJson(releasePath(requestId), {
      releasedAt: new Date().toISOString(),
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "release_requested",
        requestId,
      })}\n`
    );
    return;
  }
  const unlock = await lockWallet(`${stateDir}/wallet.lock`);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const records = await Promise.all(
      (await readdir(stateDir))
        .filter((p) => p.endsWith(".json"))
        .map(async (p) =>
          DevPreviewRecordSchema.parse(
            JSON.parse(await readFile(`${stateDir}/${p}`, "utf8"))
          )
        )
    );
    if (records.some((r) => r.accountId !== accountId))
      throw new DevPreviewError("STATE_WALLET_MISMATCH");
    let active: DevPreviewRecord | undefined;
    let paidCreateCount = 0;
    const releaseRequested = async () =>
      stopped || (!!active && (await exists(releasePath(active.requestId))));
    const save = (record: DevPreviewRecord) =>
      durableJson(`${stateDir}/${record.requestId}.json`, record);
    const adapterConfig: AkashComputeAdapterConfig = {
      apiKey,
      expectedCostConsumerAccountId: accountId,
      timeoutMs: 6000,
      writeTimeoutMs: 30000,
      deployDepositUsd: 0.5,
      maxProviderAttempts: 1,
      bootSloMs: Math.min(300000, (config?.deadlineSeconds ?? 600) * 1000),
      ...(config ? { pricing: config.pricing } : {}),
      ...(config?.allowedProviders
        ? { allowedProviders: config.allowedProviders }
        : {}),
      // One-shot DEV probe does not write fleet provider history.
      outcomeStore: { record: async () => {}, stats: async () => new Map() },
      log: { error: () => {}, warn: () => {} },
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.origin !== "https://console-api.akash.network") {
          // Existing adapter boot probes hit provider /version and /readyz, without Console custody.
          if (method !== "GET" || new Headers(init?.headers).has("x-api-key"))
            throw new DevPreviewError("UNEXPECTED_CONSOLE_ORIGIN");
          return fetch(input, init);
        }
        const paid =
          (method === "POST" &&
            ["/v1/deployments", "/v1/leases"].includes(url.pathname)) ||
          (method === "PUT" &&
            /^\/v1\/deployments\/[0-9]+$/.test(url.pathname));
        if (paid) {
          if (
            !active ||
            stopped ||
            (await releaseRequested()) ||
            Date.now() >= Date.parse(active.deadlineAt)
          ) {
            throw new DevPreviewError("PAID_REQUEST_FENCED");
          }
          if (url.pathname === "/v1/deployments") {
            if (++paidCreateCount > 1 || active.allocationSubmittedAt)
              throw new DevPreviewError("SECOND_CREATE_REFUSED");
            active.allocationSubmittedAt = new Date().toISOString();
            await save(active); // Cursor and request were already durable; submission uncertainty is durable too.
          }
          if (method === "PUT") {
            if (active.originUpdateSubmittedAt)
              throw new DevPreviewError("SECOND_ORIGIN_UPDATE_REFUSED");
            active.originUpdateSubmittedAt = new Date().toISOString();
            await save(active);
          }
        }
        const headers = new Headers(init?.headers);
        headers.set("User-Agent", "curl/8.7.1"); // Console WAF rejects the default Node/Python UA.
        const remaining = active
          ? Date.parse(active.deadlineAt) - Date.now()
          : 0;
        const signal = paid
          ? AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(Math.max(1, remaining)),
            ])
          : init?.signal;
        return fetch(input, {
          ...init,
          headers,
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
      },
    };
    const adapter = new AkashComputeAdapter(adapterConfig);
    // balances resolves /user/me.id before /wallets?userId= — the pin is a wallet ADDRESS, not user UUID.
    const balances = await adapter.balances();
    if (balances.length !== 1 || balances[0]?.accountId !== accountId)
      throw new DevPreviewError("DEV_WALLET_NOT_EXCLUSIVE");
    const deps: DevPreviewDeps = {
      provider: {
        allocationCursor: () => adapter.allocationCursor(),
        provisionWithAllocation: (input, allocated) =>
          adapter.provisionWithAllocation(input, allocated),
        findAllocationSince: (cursor) => adapter.findAllocationSince(cursor),
        release: (input) => adapter.release(input),
        status: async (input) => {
          try {
            return await adapter.status(input);
          } catch (error) {
            // Same positive absence rule as the adapter's existing closeAndVerify.
            if (
              error instanceof AkashComputeError &&
              error.code === "HTTP_ERROR" &&
              error.httpStatus === 404
            ) {
              return {
                provider: "akash",
                leaseId: input.leaseId,
                state: "closed",
                endpoints: [],
              };
            }
            throw error;
          }
        },
      },
      save,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      releaseRequested,
      emit: (record) =>
        process.stdout.write(
          `${JSON.stringify({ event: "dev_preview", ...record })}\n`
        ),
      captureCost: (leaseId) => adapter.observeCost({ resourceId: leaseId }),
      ...(config?.useIngressAuthOrigin
        ? {
            prepareAuthenticatedOrigin: async (output, spec) => {
              if (!active) throw new DevPreviewError("NO_ACTIVE_REQUEST");
              let origin: string | undefined;
              for (const endpoint of output.endpoints) {
                const raw = /^https?:\/\//.test(endpoint)
                  ? endpoint
                  : `http://${endpoint}`;
                let candidate: URL;
                try {
                  candidate = new URL(raw);
                } catch {
                  continue;
                }
                if (candidate.username || candidate.password) continue;
                if (
                  (await safeVersionProbeResult(
                    candidate.origin,
                    config.sourceSha
                  )) === "matched"
                ) {
                  origin = candidate.origin;
                  break;
                }
              }
              if (!origin) throw new DevPreviewError("AUTH_ORIGIN_NOT_PROVEN");
              // A second adapter changes only this read/boot budget, never provider policy or allocation count.
              const remaining = Date.parse(active.deadlineAt) - Date.now();
              if (remaining <= 20000 || (await releaseRequested()))
                throw new DevPreviewError("REQUEST_EXPIRED_OR_RELEASED");
              const updateAdapter = new AkashComputeAdapter({
                ...adapterConfig,
                bootSloMs: Math.min(300000, remaining - 15000),
              });
              const updated = await updateAdapter.update({
                resourceId: output.leaseId,
                env: "dev-probe",
                expectedSourceSha: config.sourceSha,
                idempotencyKey: `${config.requestId}:auth-origin`,
                spec: {
                  ...spec,
                  services: spec.services.map((s) => ({
                    ...s,
                    env: {
                      ...s.env,
                      NEXTAUTH_URL: origin,
                      APP_BASE_URL: origin,
                    },
                  })),
                },
              });
              return { output: updated, origin };
            },
          }
        : {}),
    };
    // Outstanding cleanup wins over every new request. No blind retry of provision.
    for (const record of records.filter((r) => r.phase !== "closed")) {
      active = record;
      await closeDevPreview(record, deps);
    }
    if (values.cleanup) return;
    if (!config) throw new DevPreviewError("CONFIG_REQUIRED");
    const previous = records.find((r) => r.requestId === config.requestId);
    const record = newDevPreviewRecord(config, accountId, Date.now());
    if (previous) {
      if (previous.requestHash !== record.requestHash)
        throw new DevPreviewError("REQUEST_CONFLICT");
      throw new DevPreviewError("REQUEST_ALREADY_TERMINAL");
    }
    // Do not mix this supervised writer with a manually opened, untracked DEV allocation.
    const existingAllocation = await adapter.findAllocationSince("-1");
    if (existingAllocation.outcome !== "settled")
      throw new DevPreviewError("UNTRACKED_DEV_ALLOCATION");
    active = record;
    await runDevPreview(config, record, deps);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await unlock();
  }
}

main().catch((error: unknown) => {
  // Never stringify raw validation issues, config, URLs, provider bodies or stack traces.
  process.stderr.write(
    `${JSON.stringify({
      event: "dev_preview_failed",
      code:
        error instanceof AkashComputeError ? error.code : safeFailure(error),
    })}\n`
  );
  process.exitCode = 1;
});
