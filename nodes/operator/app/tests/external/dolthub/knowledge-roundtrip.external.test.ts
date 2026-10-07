// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/dolthub/knowledge-roundtrip.external`
 * Purpose: Prove the operator's REAL adapters can add knowledge (contribution+merge)
 *   AND a work item (create+patch), sync them to DoltHub (dolt_push), and recover
 *   them by a fresh clone — the app-code round-trip, end to end.
 * Scope: Live Doltgres (docker CLI) + live DoltHub under an explicit TEST owner.
 * Invariants:
 *   - Requires DOLTHUB_API_TOKEN + DOLTHUB_EXTERNAL_TEST_OWNER + DOLT_CREDS_JWK +
 *     DOLT_CREDS_KEYID; skips without them. NEVER targets cogni-dao (fail closed).
 *   - Drives the SAME modules the operator container wires: createDoltHubDatabaseEnsurer,
 *     DoltgresKnowledgeContributionAdapter + createContributionService + shapeGate +
 *     createDoltgresPusher/wrapPushSafe, DoltgresWorkItemAdapter.
 * Side-effects: Docker containers; durable repo creation under the test owner.
 *
 * ── HOW TO RUN (prerequisites to replicate) ─────────────────────────────────
 *   Command:  pnpm -F operator test:external:dolthub:roundtrip
 *   (Skips cleanly unless ALL four env vars below are set.)
 *
 *   1. Docker daemon running + reachable. The test shells out to `docker run` /
 *      `docker port` / `docker rm` and pulls dolthub/doltgresql:0.57.3 on first use.
 *      We use the docker CLI rather than the `testcontainers` package on purpose so
 *      the lane carries one fewer transitive dependency.
 *   2. DOLTHUB_API_TOKEN — a DoltHub Personal Access Token (DoltHub → Settings →
 *      API Tokens) whose account can CREATE repos under DOLTHUB_EXTERNAL_TEST_OWNER.
 *   3. DOLTHUB_EXTERNAL_TEST_OWNER — a DoltHub org/user that is NOT `cogni-dao`
 *      (the guard throws otherwise). Canonically `cogni-test-nodes`. A durable public
 *      repo `e2e-rt-<stamp>-<suffix>` is created there each run — DoltHub has no delete
 *      API, so these accumulate; prune manually if desired.
 *   4. DOLT_CREDS_JWK + DOLT_CREDS_KEYID — a DoltHub key-pair that can PUSH to that
 *      same owner. JWK = full contents of ~/.dolt/creds/<keyid>.jwk (the {kty,crv,d,x}
 *      object); KEYID = that file's basename. Manage via `dolt creds new/ls` and
 *      confirm with `dolt creds check`. The token (create) and key-pair (push) are
 *      DISTINCT credentials — BOTH must have access to the owner.
 *
 *   `@cogni/*` workspace packages resolve from src via tsconfig.e2e-roundtrip.json, so
 *   NO prior `pnpm build` is required. Not run in PR CI (external lane, ❌ in CI).
 * ────────────────────────────────────────────────────────────────────────────
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, .context/dolthub-e2e-roundtrip-plan.md
 * @internal
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createContributionService,
  defaultCanMergeKnowledge,
  shapeGate,
} from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  createDoltgresPusher,
  DoltgresKnowledgeContributionAdapter,
  DoltgresKnowledgeStoreAdapter,
  wrapPushSafe,
} from "@cogni/knowledge-store/adapters/doltgres";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDoltHubDatabaseEnsurer } from "@/features/nodes/dolthub-database";
import { buildNodeKnowledgeRemote } from "@/shared/node-app-scaffold/knowledge-remote";

const execFileAsync = promisify(execFile);

const DOLTHUB_API_TOKEN = process.env.DOLTHUB_API_TOKEN ?? "";
const TEST_OWNER = process.env.DOLTHUB_EXTERNAL_TEST_OWNER ?? "";
const DOLT_CREDS_JWK = process.env.DOLT_CREDS_JWK ?? "";
const DOLT_CREDS_KEYID = process.env.DOLT_CREDS_KEYID ?? "";

const hasRequiredEnv = Boolean(
  DOLTHUB_API_TOKEN && TEST_OWNER && DOLT_CREDS_JWK && DOLT_CREDS_KEYID
);

// Fail closed: never let a misconfigured run write to the production knowledge org.
if (hasRequiredEnv && TEST_OWNER === "cogni-dao") {
  throw new Error(
    "DOLTHUB_EXTERNAL_TEST_OWNER must not be cogni-dao — this test creates a durable repo; point it at a test org (e.g. cogni-test-nodes)."
  );
}

const IMAGE = "dolthub/doltgresql:0.57.3";
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const MIGRATIONS_DIR =
  "nodes/operator/app/src/adapters/server/db/doltgres-migrations";

const configGlobal = JSON.stringify({
  "user.creds": DOLT_CREDS_KEYID,
  "user.name": "cogni",
  "user.email": "steward@cognidao.org",
});

/**
 * A running Doltgres container, addressed via the docker CLI. We use `docker`
 * directly rather than the `testcontainers` package so the lane has one fewer
 * transitive dependency to keep healthy — the only host requirement is Docker.
 */
interface DoltgresBox {
  readonly name: string;
  readonly port: number;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 8 << 20,
  });
  return stdout.trim();
}

/** Boot a Doltgres server; when withCreds, pre-install the push creds (mirrors install-creds.sh). */
async function startDoltgres(
  label: string,
  withCreds: boolean
): Promise<DoltgresBox> {
  const name = `cogni-e2e-${label}-${randomUUID().slice(0, 8)}`;
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "DOLTGRES_PASSWORD=password",
  ];
  if (withCreds) {
    const dir = await mkdtemp(path.join(tmpdir(), "cogni-dgcreds-"));
    await mkdir(path.join(dir, "creds"), { recursive: true });
    const jwk = path.join(dir, "creds", `${DOLT_CREDS_KEYID}.jwk`);
    await writeFile(jwk, DOLT_CREDS_JWK);
    await chmod(jwk, 0o600);
    await writeFile(path.join(dir, "config_global.json"), configGlobal);
    args.push("-v", `${dir}:/root/.dolt`);
  }
  args.push(IMAGE);
  await docker(args);
  const portLine = await docker(["port", name, "5432"]); // "127.0.0.1:49xxx"
  const port = Number(portLine.split(":").pop());
  return { name, port };
}

function urlFor(box: DoltgresBox, db: string): string {
  return `postgres://postgres:password@127.0.0.1:${box.port}/${db}`;
}

async function stop(box: DoltgresBox | undefined): Promise<void> {
  if (box) await docker(["rm", "-f", box.name]).catch(() => {});
}

async function waitReady(box: DoltgresBox): Promise<void> {
  const sql = postgres(urlFor(box, "postgres"), { max: 1 });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await sql`SELECT 1`;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("doltgres did not become ready");
  } finally {
    await sql.end();
  }
}

describe.skipIf(!hasRequiredEnv)(
  "operator knowledge + work-item DoltHub round-trip (external)",
  () => {
    const stamp = Date.now().toString(36);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
    const slug = `e2e-rt-${stamp}-${suffix}`; // matches ^[a-z][a-z0-9-]{0,63}$
    const remote = buildNodeKnowledgeRemote(slug, TEST_OWNER);

    let source: DoltgresBox;

    beforeAll(async () => {
      source = await startDoltgres("src", true);
      await waitReady(source);
      // Create the per-node knowledge DB, then apply the REAL migrator.
      const admin = postgres(urlFor(source, "postgres"), { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE ${remote.database}`);
      } finally {
        await admin.end();
      }
      await execFileAsync(
        "node",
        [path.join("scripts", "db", "migrate-doltgres.mjs"), MIGRATIONS_DIR],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NODE_NAME: "operator",
            DATABASE_URL: urlFor(source, remote.database),
          },
        }
      );
    });

    afterAll(async () => {
      await stop(source);
    });

    it("creates the repo, contributes+merges knowledge, writes a work item, pushes, and recovers by clone", async () => {
      const sql = buildDoltgresClient({
        connectionString: urlFor(source, remote.database),
        applicationName: "e2e_roundtrip_test",
      });

      // 1. App create path — DoltHub repo via REST ensurer + PAT.
      const dh = await createDoltHubDatabaseEnsurer({
        DOLTHUB_API_TOKEN,
      }).ensureDatabase({
        owner: remote.owner,
        repo: remote.repo,
        description: `Cogni external round-trip proof ${slug}`,
      });
      expect(dh.owner).toBe(TEST_OWNER);
      expect(dh.repo).toBe(remote.repo);

      // 2. Domain precondition.
      const store = new DoltgresKnowledgeStoreAdapter({ sql });
      await store.registerDomain({ id: "proof", name: "Proof Domain" });

      // 3. Work item create + patch (auto-commits to main).
      const wi = new DoltgresWorkItemAdapter(sql);
      const created = await wi.create(
        { type: "task", title: "E2E round-trip work item" } as never,
        "e2e-agent"
      );
      const patched = await wi.patch(
        { id: created.id, set: { status: "in_progress" } } as never,
        "e2e-agent"
      );
      expect(patched?.status).toBe("in_progress");

      // 4. Knowledge contribution + merge with the REAL push hook (as the
      //    operator container wires it). Capture the push the service fires.
      let pushOutcome: unknown = "not-fired";
      let pushDone: Promise<void> | null = null;
      const pushMainOnMerge = () => {
        pushDone = wrapPushSafe(
          createDoltgresPusher({
            sql,
            remoteName: "origin",
            remoteUrl: remote.url,
          }),
          {
            onSuccess: () => {
              pushOutcome = "ok";
            },
            onFailure: (err) => {
              pushOutcome = { error: String(err) };
            },
          }
        )();
        return pushDone;
      };

      const svc = createContributionService({
        port: new DoltgresKnowledgeContributionAdapter({ sql }),
        canMergeKnowledge: defaultCanMergeKnowledge,
        gates: [shapeGate],
        pushMainOnMerge,
      });

      const contrib = await svc.create({
        principal: { id: "e2e-agent", kind: "agent", role: "contributor" },
        body: {
          message: "E2E proof: add knowledge entry",
          edits: [
            {
              op: "insert",
              entry: {
                id: "e2e-proof-entry",
                domain: "proof",
                title: "E2E app round-trip proof entry",
                content:
                  "Written by the operator contribution service and pushed to DoltHub.",
                entryType: "reference",
              },
            },
          ],
        },
      });
      await svc.merge({
        principal: { id: "e2e-user", kind: "user", role: "admin" },
        contributionId: contrib.contributionId,
      });
      if (pushDone) await pushDone;
      expect(pushOutcome).toBe("ok");
      await sql.end();

      // 5. RECOVER — fresh Doltgres, clone the pushed repo, verify BOTH records.
      const recover = await startDoltgres("recover", false);
      try {
        await waitReady(recover);
        const rsql = postgres(urlFor(recover, "postgres"), { max: 1 });
        try {
          await rsql.unsafe(
            `SELECT dolt_clone('${remote.owner}/${remote.repo}')`
          );
        } finally {
          await rsql.end();
        }
        const rdb = postgres(urlFor(recover, remote.repo), { max: 1 });
        try {
          const k = await rdb.unsafe(
            "SELECT id, domain FROM knowledge WHERE id = 'e2e-proof-entry'"
          );
          const w = await rdb.unsafe(
            `SELECT id, status FROM work_items WHERE id = '${created.id}'`
          );
          expect(k.length).toBe(1);
          expect(w.length).toBe(1);
          expect((w[0] as { status: string }).status).toBe("in_progress");
        } finally {
          await rdb.end();
        }
      } finally {
        await stop(recover);
      }

      console.log(
        `round-trip proven: ${remote.owner}/${remote.repo} (knowledge + ${created.id})`
      );
    });
  }
);
