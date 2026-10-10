// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/component/db/doltgres-usewhen-patch.int.test.ts`
 * Purpose: Prove against a real Doltgres that `op:'patch'` refines a retrieval trigger while leaving the body byte-identical, and that `listKnowledge({q})` finds the entry by a `useWhen` substring (task.5204).
 * Scope: Component test — boots `dolthub/doltgresql:latest` via testcontainers and drives `DoltgresKnowledgeContributionAdapter` + `DoltgresKnowledgeStoreAdapter` directly. Does not exercise HTTP routes, auth, or the contribution service's policy gates.
 * Invariants:
 *   - RED CONTROL first: the pre-existing `op:'update'` path is shown to clobber
 *     `content` on a resend that drifts, so the green `patch` case cannot be
 *     mistaken for a body that was never at risk.
 *   - PATCH_CARRIES_ONLY_UNGATED_FIELDS: a patch that refines `useWhen` must
 *     leave `content` byte-identical, and must actively REFUSE every
 *     gate-governed field (`content`, `title`, `tags`, `id`, `sourceRef`) plus
 *     `domain` — so the op cannot become a route around the write-gate chain.
 *     An empty partial must be rejected rather than acknowledged as a write.
 *   - Q_MATCHES_USEWHEN_ONLY: `q` matches the trigger, never the title or body.
 * Side-effects: Docker container, sub-process (migrator), database writes.
 * Links: packages/knowledge-store/src/domain/contribution-schemas.ts, packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EmptyKnowledgePatchError,
  KnowledgeContributionEditSchema,
} from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  DoltgresKnowledgeContributionAdapter,
  DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const MIGRATE_SCRIPT = path.resolve(
  REPO_ROOT,
  "scripts/db/migrate-doltgres.mjs"
);
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  "nodes/operator/app/src/adapters/server/db/doltgres-migrations"
);

const DG_USER = "postgres";
const DG_PASSWORD = "doltgres";
const DG_DB = "knowledge_operator";

const DOMAIN = "patchproof";

/**
 * A body big enough that resending it is a real cost and a real hazard — the
 * defect `op:'patch'` exists to remove. `op:'update'` requires a full
 * `KnowledgeEntryInputSchema`, so before this op the ONLY way to sharpen one
 * line of `useWhen` was to replay all of this.
 */
const LONG_CONTENT = `${"The operator fleet promotes by digest, never by tag. ".repeat(
  400
)}\n\n- tail marker: 7f3a9c1`;

const principal = (name: string) => ({
  id: `agent:${name}`,
  kind: "agent" as const,
  name,
});

describe("knowledge useWhen patch + q filter (task.5204)", () => {
  let container: StartedTestContainer;
  let dbUrl: string;
  let readClient: Sql;
  let branchClient: Sql;
  let adapter: DoltgresKnowledgeContributionAdapter;
  let store: DoltgresKnowledgeStoreAdapter;

  /** Open a contribution carrying `edits`, then merge it so `main` sees it. */
  async function contributeAndMerge(
    who: string,
    message: string,
    edits: Parameters<
      DoltgresKnowledgeContributionAdapter["create"]
    >[0]["edits"]
  ): Promise<void> {
    const rec = await adapter.create({
      principal: principal(who),
      message,
      ...(edits ? { edits } : {}),
    });
    await adapter.merge({
      contributionId: rec.contributionId,
      principal: principal(who),
    });
  }

  async function seedEntry(
    id: string,
    useWhen: string,
    content = LONG_CONTENT
  ): Promise<void> {
    await contributeAndMerge(`seed-${id}`, `seed ${id}`, [
      {
        op: "insert",
        entry: {
          id,
          domain: DOMAIN,
          title: `Entry ${id}`,
          content,
          useWhen,
          entryType: "finding",
        },
      },
    ]);
  }

  beforeAll(async () => {
    container = await new GenericContainer("dolthub/doltgresql:latest")
      .withEnvironment({ DOLTGRES_PASSWORD: DG_PASSWORD })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          60_000
        )
      )
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const baseUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/postgres`;
    dbUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/${DG_DB}`;

    const bootstrap = postgres(baseUrl, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE ${DG_DB}`);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    } finally {
      await bootstrap.end({ timeout: 5 });
    }

    execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
      encoding: "utf8",
      stdio: "pipe",
    });

    readClient = buildDoltgresClient({ connectionString: dbUrl });
    const createBranchClient = () =>
      buildDoltgresClient({ connectionString: dbUrl, max: 1 });
    branchClient = createBranchClient();
    adapter = new DoltgresKnowledgeContributionAdapter({
      sql: readClient,
      branchSql: branchClient,
      recreateBranchClient: createBranchClient,
    });
    store = new DoltgresKnowledgeStoreAdapter({ sql: readClient });

    // DOMAIN_FK_ENFORCED_AT_WRITE — the shelf must exist on `main` before any
    // branch write, because the contribution branch forks from it.
    await store.registerDomain({ id: DOMAIN, name: "Patch proof shelf" });
  }, 240_000);

  afterAll(async () => {
    await readClient?.end({ timeout: 5 }).catch(() => undefined);
    await branchClient?.end({ timeout: 5 }).catch(() => undefined);
    if (container) await container.stop();
  });

  it("RED CONTROL: op:'update' clobbers content when the resend drifts", async () => {
    // This is the defect. `op:'update'` carries a FULL entry, so a caller that
    // only means to sharpen `useWhen` must replay the body — and any drift or
    // truncation in that replay overwrites it silently, with a 200.
    await seedEntry("red-control", "use when auditing promote digests");

    await contributeAndMerge("clobberer", "sharpen the trigger via update", [
      {
        op: "update",
        targetRowId: "red-control",
        entry: {
          id: "red-control",
          domain: DOMAIN,
          title: "Entry red-control",
          // The caller's resend is truncated. Nothing in the contract objects.
          content: "oops, truncated resend",
          useWhen: "use when auditing promote digests on candidate-a",
          entryType: "finding",
        },
      },
    ]);

    const after = await store.getKnowledge("red-control");
    expect(after?.useWhen).toBe(
      "use when auditing promote digests on candidate-a"
    );
    // The body is gone. 64 KiB of knowledge, destroyed by a trigger edit.
    expect(after?.content).toBe("oops, truncated resend");
    expect(after?.content).not.toBe(LONG_CONTENT);
  }, 180_000);

  it("GREEN: op:'patch' refines useWhen and leaves content byte-identical", async () => {
    await seedEntry("patch-keeps-body", "use when reading promote logs");
    const before = await store.getKnowledge("patch-keeps-body");
    expect(before?.content).toBe(LONG_CONTENT);
    expect(before?.content.length).toBeGreaterThan(20_000);

    await contributeAndMerge("refiner", "sharpen the trigger via patch", [
      {
        op: "patch",
        targetRowId: "patch-keeps-body",
        entry: {
          useWhen:
            "use when a promote reports success but buildSha did not advance",
        },
      },
    ]);

    const after = await store.getKnowledge("patch-keeps-body");
    expect(after?.useWhen).toBe(
      "use when a promote reports success but buildSha did not advance"
    );
    // The point of the op: the body is untouched, byte for byte.
    expect(after?.content).toBe(LONG_CONTENT);
    expect(after?.content.length).toBe(LONG_CONTENT.length);
    // Untouched fields stay untouched; provenance is still stamped.
    expect(after?.title).toBe("Entry patch-keeps-body");
    expect(after?.domain).toBe(DOMAIN);
    expect(after?.sourceType).toBe("external");
    expect(after?.sourceRef).toMatch(/^contribution:.+:1$/);
  }, 180_000);

  it("PATCH_CARRIES_ONLY_UNGATED_FIELDS: every gate-governed field is refused", async () => {
    // The op exists and `useWhen` alone is accepted (proved above), so each
    // rejection here is the schema ACTIVELY refusing a field — not an artifact
    // of the op being absent. A patch may carry only what no write gate
    // governs; anything else must go through `op:'update'`, where the chain
    // runs. These are 400s, not silently dropped keys, so a caller can never
    // believe such a write landed.
    const excluded: ReadonlyArray<[string, Record<string, unknown>]> = [
      // shape gate: content_empty
      ["content", { content: "sneaky body" }],
      // shape gate: 3–60 chars, trailing punctuation, ` · ` separators
      ["title", { title: "a title the shape gate would reject." }],
      // shape gate: ≤16 tags, each 1–32 chars
      ["tags", { tags: ["sneaky"] }],
      // shape gate: kebab slug, 1–4 segments
      ["id", { id: "some-other-row" }],
      // provenance gate — the adapter stamps provenance itself
      ["sourceType", { sourceType: "human" }],
      ["sourceRef", { sourceRef: "https://example.invalid" }],
      // ungated, but a shelf move is a separately reviewable decision
      ["domain", { domain: "someother" }],
      ["entityId", { entityId: "ent-1" }],
      ["confidencePct", { confidencePct: 99 }],
    ];

    for (const [field, extra] of excluded) {
      const parsed = KnowledgeContributionEditSchema.safeParse({
        op: "patch",
        targetRowId: "patch-keeps-body",
        entry: { useWhen: "use when the gate hole is closed", ...extra },
      });
      expect(parsed.success, `patch must refuse '${field}'`).toBe(false);
    }

    // Control: the two ungated fields are accepted, together and alone — so the
    // loop above is not just "strictObject rejects everything".
    expect(
      KnowledgeContributionEditSchema.safeParse({
        op: "patch",
        targetRowId: "patch-keeps-body",
        entry: { useWhen: "use when the gate hole is closed" },
      }).success
    ).toBe(true);
    expect(
      KnowledgeContributionEditSchema.safeParse({
        op: "patch",
        targetRowId: "patch-keeps-body",
        entry: { entryType: "guide" },
      }).success
    ).toBe(true);
  });

  it("GREEN: op:'patch' can refine entryType, the other ungated field", async () => {
    await seedEntry("patch-entrytype", "use when classifying a shelf entry");
    await contributeAndMerge("retyper", "reclassify via patch", [
      {
        op: "patch",
        targetRowId: "patch-entrytype",
        entry: { entryType: "guide" },
      },
    ]);

    const after = await store.getKnowledge("patch-entrytype");
    expect(after?.entryType).toBe("guide");
    // Still byte-identical, and the trigger it did not name is untouched.
    expect(after?.content).toBe(LONG_CONTENT);
    expect(after?.useWhen).toBe("use when classifying a shelf entry");
  }, 180_000);

  it("PATCH_IS_NOT_EMPTY: an empty partial is rejected, not a silent no-op", async () => {
    const parsed = KnowledgeContributionEditSchema.safeParse({
      op: "patch",
      targetRowId: "patch-keeps-body",
      entry: {},
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("useWhen");
    }

    // Defense in depth: a caller that bypasses the wire schema still cannot
    // get a no-op UPDATE acknowledged as an applied write.
    await expect(
      adapter.create({
        principal: principal("emptier"),
        message: "empty patch",
        edits: [
          {
            op: "patch",
            targetRowId: "patch-keeps-body",
            entry: {},
          },
        ],
      })
    ).rejects.toThrow(EmptyKnowledgePatchError);
  }, 180_000);

  it("Q_MATCHES_USEWHEN_ONLY: listKnowledge finds the entry by a useWhen substring", async () => {
    await seedEntry(
      "q-match",
      "use when a Dolt branch session wedges the pool"
    );
    await seedEntry("q-nomatch", "use when a DNS record points at a dead VM");

    const hits = await store.listKnowledge(DOMAIN, { q: "branch session" });
    const ids = hits.map((r) => r.id);
    expect(ids).toContain("q-match");
    expect(ids).not.toContain("q-nomatch");

    // Case-insensitive: Doltgres has no ILIKE, so this proves the app-layer
    // fold actually runs.
    const upper = await store.listKnowledge(DOMAIN, { q: "BRANCH SESSION" });
    expect(upper.map((r) => r.id)).toContain("q-match");

    // The filter is on the trigger, not the title or the body. Every seeded
    // entry shares `LONG_CONTENT`, which contains "promotes by digest".
    const bodyNeedle = await store.listKnowledge(DOMAIN, {
      q: "promotes by digest",
    });
    expect(bodyNeedle).toHaveLength(0);
    const titleNeedle = await store.listKnowledge(DOMAIN, { q: "Entry q-" });
    expect(titleNeedle).toHaveLength(0);

    // A nonsense needle returns nothing rather than the whole shelf.
    expect(
      await store.listKnowledge(DOMAIN, { q: "no-such-trigger-anywhere" })
    ).toHaveLength(0);
    // And no `q` still lists the shelf.
    expect(
      (await store.listKnowledge(DOMAIN, { limit: 100 })).length
    ).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
