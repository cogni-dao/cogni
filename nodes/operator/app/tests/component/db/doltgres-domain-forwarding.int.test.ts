// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFileSync, realpathSync } from "node:fs";
/**
 * Module: `@tests/component/db/doltgres-domain-forwarding`
 * Purpose: Prove installed domain operations use the private native admission exactly once.
 * Scope: Existing pinned testcontainers native lane, private adapter and real item handlers.
 * Invariants: No cross-realm guards; retained SQL expires; refusals/no-ops preserve HEAD and rows.
 * Side-effects: IO (ephemeral native database/container)
 * Notes: Handler coverage is explicitly required by the approved domain composition design.
 * Links: https://cognidao.org/work/items/task.5391
 * @internal
 */
import { createRequire } from "node:module";
import path from "node:path";
import {
  DomainNotEmptyError,
  DomainNotRegisteredError,
  type KnowledgeStorePort,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
} from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  DoltBranchSessionRunner,
  DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import { DomainNotEmptyError as PublishedNonempty } from "@cogni/shared-knowledge-store";
import * as operations from "@cogni/shared-knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const binding = vi.hoisted(() => ({
  port: undefined as KnowledgeStorePort | undefined,
}));
vi.mock("../../../src/bootstrap/container.ts", () => ({
  getContainer: () => ({ knowledgeStorePort: binding.port }),
}));
// Observe public delegation and retain its callback, while executing the ACTUAL installed helper.
// Neither SQL results nor the native executor/guard/admission are mocked.
vi.mock(
  "@cogni/shared-knowledge-store/adapters/doltgres",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@cogni/shared-knowledge-store/adapters/doltgres")
      >();
    return {
      ...actual,
      updateDoltgresDomain: vi.fn(actual.updateDoltgresDomain),
      deleteDoltgresDomain: vi.fn(actual.deleteDoltgresDomain),
    };
  }
);
const IMAGE =
  "ghcr.io/cogni-dao/cogni-template@sha256:f892b365ad6fc6c683da839260f20c4015615c105176a3c21c015ca90d2b70a3";
const principal = {
  id: "native-domain-test",
  displayName: "Native domain test",
  walletAddress: null,
  avatarColor: null,
};
const patch = (body: unknown) =>
  new Request("http://localhost/api/v1/knowledge/domains/demo", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
const require = createRequire(import.meta.url);

describe("installed domain artifacts", () => {
  it("shares one knowledge artifact across aliases and public tool peers", async () => {
    const canonical = realpathSync(
      require.resolve("@cogni-dao/knowledge-store/contracts")
    );
    expect(
      realpathSync(require.resolve("@cogni/shared-knowledge-store/contracts"))
    ).toBe(canonical);
    for (const consumer of [
      "@cogni/ai-tools",
      "@cogni/knowledge-store",
      "@cogni/node-contracts",
    ]) {
      const consumerRequire = createRequire(import.meta.resolve(consumer));
      expect(
        realpathSync(
          consumerRequire.resolve("@cogni/shared-knowledge-store/contracts")
        )
      ).toBe(canonical);
    }
    const toolEntry = require.resolve("@cogni/shared-ai-tools");
    const toolRequire = createRequire(toolEntry);
    expect(
      realpathSync(toolRequire.resolve("@cogni-dao/knowledge-store/contracts"))
    ).toBe(canonical);
    const packagePath = path.resolve(
      path.dirname(canonical),
      "../package.json"
    );
    expect(JSON.parse(readFileSync(packagePath, "utf8")).version).toBe("0.9.0");
    const shared = await import("@cogni/shared-knowledge-store/contracts");
    const contracts = await import("@cogni/node-contracts");
    expect(contracts.KnowledgeRowSchema).toBe(shared.KnowledgeRowSchema);
    const tools = await import("@cogni/shared-ai-tools");
    const localTools = await import("@cogni/ai-tools");
    const work = await import("@cogni/work-items");
    for (const field of Object.keys(work.WorkItemDtoSchema.shape)) {
      expect(
        tools.WorkItemQueryOutputSchema.shape.items.element.shape
      ).toHaveProperty(field);
      expect(
        localTools.WorkItemQueryOutputSchema.shape.items.element.shape
      ).toHaveProperty(field);
    }

    expect(DomainNotEmptyError).toBe(PublishedNonempty);
    console.info(
      JSON.stringify({
        receipt: "operator-domain-artifact-binding",
        canonical,
        toolEntry,
        knowledgeVersion: "0.9.0",
      })
    );
  });
});

describe("private native domain forwarding", () => {
  let container: StartedTestContainer | undefined;
  let reader: Sql | undefined;
  let branch: Sql | undefined;
  let store: DoltgresKnowledgeStoreAdapter;
  let handlers: typeof import("@/app/api/v1/knowledge/domains/_handlers");
  let writer: DoltBranchSessionRunner;
  async function snapshot() {
    if (!reader) throw new Error("native fixture unavailable");
    return {
      head: (await reader.unsafe("SELECT dolt_hashof('HEAD') AS head"))[0]
        ?.head,
      domains: await reader.unsafe("SELECT * FROM domains ORDER BY id"),
      entries: await reader.unsafe("SELECT * FROM knowledge ORDER BY id"),
    };
  }
  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ DOLTGRES_PASSWORD: "native-domain-test" })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          90_000
        )
      )
      .start();
    const origin = `postgresql://postgres:native-domain-test@${container.getHost()}:${container.getMappedPort(5432)}`;
    const admin = postgres(`${origin}/postgres`, {
      max: 1,
      prepare: false,
      fetch_types: false,
    });
    try {
      await admin.unsafe("CREATE DATABASE knowledge_domain_forwarding");
    } finally {
      await admin.end();
    }
    const url = `${origin}/knowledge_domain_forwarding`;
    reader = buildDoltgresClient({ connectionString: url, max: 1 });
    await reader.unsafe(
      "CREATE TABLE domains (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, confidence_pct INTEGER DEFAULT 40, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
    );
    await reader.unsafe(
      "CREATE TABLE knowledge (id TEXT PRIMARY KEY, domain TEXT)"
    );
    await reader.unsafe(
      "INSERT INTO domains (id,name,description) VALUES ('demo','Before','initial'),('occupied','Occupied',NULL),('meta','Meta',NULL)"
    );
    await reader.unsafe(
      "INSERT INTO knowledge VALUES ('entry-one','occupied')"
    );
    await reader.unsafe("SELECT dolt_add('-A')");
    await reader.unsafe(
      "SELECT dolt_commit('-m','domain fixture','--author','test <test@local.invalid>')"
    );
    branch = buildDoltgresClient({ connectionString: url, max: 1 });
    writer = new DoltBranchSessionRunner(branch, {
      writerProtocol: "database",
    });
    store = new DoltgresKnowledgeStoreAdapter({
      sql: reader,
      writerSession: writer,
    });
    binding.port = store;
    handlers = await import("@/app/api/v1/knowledge/domains/_handlers");
  });
  afterAll(async () => {
    binding.port = undefined;
    await branch?.end({ timeout: 5 });
    await reader?.end({ timeout: 5 });
    await container?.stop();
  });
  it("delegates the installed update with one private admission and expires every retained query", async () => {
    const admission = vi.spyOn(writer, "run");
    const helper = vi.mocked(operations.updateDoltgresDomain);
    helper.mockClear();
    const before = await snapshot();
    const response = await handlers.handleUpdate(
      patch({ name: "After", description: null }),
      "demo",
      principal
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "demo",
      name: "After",
      description: null,
    });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledTimes(1);
    const retained = helper.mock.calls[0]?.[0];
    expect(retained).toBeDefined();
    expect(() => retained?.("SELECT 1")).toThrow(
      KnowledgeWriteScopeRequiredError
    );
    expect(() => retained?.("SELECT 2")).toThrow(
      KnowledgeWriteScopeRequiredError
    );
    expect((await snapshot()).head).not.toBe(before.head);
    admission.mockRestore();
  });
  it("preserves omitted description and clears only explicit null", async () => {
    const created = await handlers.handleCreate(
      patch({ id: "metadata", name: "Metadata", description: "retain" }),
      principal
    );
    expect(created.status).toBe(201);
    expect(
      await store.updateDomain("metadata", { name: "Renamed" })
    ).toMatchObject({ description: "retain" });
    expect(
      await store.updateDomain("metadata", { description: null })
    ).toMatchObject({ description: null });
    await store.deleteDomain("metadata");
  });
  it("keeps native HEAD and rows unchanged for empty/unchanged/omitted patches", async () => {
    const before = await snapshot();
    await store.updateDomain("demo", {});
    await store.updateDomain("demo", { name: "After" });
    expect(await snapshot()).toEqual(before);
    console.info(
      JSON.stringify({
        receipt: "operator-domain-native-noop",
        head: before.head,
        domainRows: before.domains,
        knowledgeRows: before.entries,
      })
    );
  });
  it("preserves shared nonempty and private missing constructor identities through real handlers", async () => {
    const before = await snapshot();
    expect(await store.getDomain("not-present")).toBeNull();
    await expect(
      store.updateDomain("not-present", { name: "Missing" })
    ).rejects.toBeInstanceOf(DomainNotRegisteredError);
    await expect(store.deleteDomain("not-present")).rejects.toBeInstanceOf(
      DomainNotRegisteredError
    );
    await expect(store.deleteDomain("occupied")).rejects.toBeInstanceOf(
      PublishedNonempty
    );
    expect((await handlers.handleGet("not-present", principal)).status).toBe(
      404
    );
    expect(
      (
        await handlers.handleUpdate(
          patch({ name: "Missing" }),
          "not-present",
          principal
        )
      ).status
    ).toBe(404);
    expect((await handlers.handleDelete("not-present", principal)).status).toBe(
      404
    );
    const nonempty = await handlers.handleDelete("occupied", principal);
    expect(nonempty.status).toBe(409);
    expect(await nonempty.json()).toMatchObject({
      errorCode: "domain_not_empty",
      entryCount: 1,
    });
    expect((await handlers.handleDelete("meta", principal)).status).toBe(409);
    expect(
      (await handlers.handleUpdate(patch({}), "demo", principal)).status
    ).toBe(400);
    expect(
      (await handlers.handleUpdate(patch(null), "demo", principal)).status
    ).toBe(400);
    expect(
      (
        await handlers.handleUpdate(
          patch({ id: "rename", name: "After" }),
          "demo",
          principal
        )
      ).status
    ).toBe(400);
    expect(
      (
        await handlers.handleUpdate(
          new Request("http://localhost", { method: "PATCH", body: "{bad" }),
          "demo",
          principal
        )
      ).status
    ).toBe(400);
    expect((await handlers.handleGet("../invalid", principal)).status).toBe(
      400
    );
    expect((await handlers.handleDelete("demo", null)).status).toBe(401);
    expect(
      (
        await handlers.handleList(
          new Request("http://localhost", {
            headers: { Authorization: "Bearer transport-test" },
          }),
          principal
        )
      ).status
    ).toBe(403);

    expect(await snapshot()).toEqual(before);
    console.info(
      JSON.stringify({
        receipt: "operator-domain-native-refusals",
        head: before.head,
        domainRows: before.domains,
        knowledgeRows: before.entries,
      })
    );
  });
  it("preserves an original SQL error thrown by the delegate before DML", async () => {
    if (!reader) throw new Error("native fixture unavailable");
    const actual = await vi.importActual<typeof operations>(
      "@cogni/shared-knowledge-store/adapters/doltgres"
    );
    let original: unknown;
    try {
      await reader.unsafe("SELECT * FROM operator_absent_relation");
    } catch (error) {
      original = error;
    }
    expect(original).toBeDefined();
    const before = await snapshot();
    vi.mocked(operations.updateDoltgresDomain).mockImplementationOnce(
      async (query, id) => {
        await actual.getDoltgresDomain(query, id);
        throw original;
      }
    );
    await expect(store.updateDomain("demo", { name: "Fails" })).rejects.toBe(
      original
    );
    expect(await snapshot()).toEqual(before);
  });
  it("retains native uncertainty as a typed non-replay receipt through the real handler", async () => {
    const actual = await vi.importActual<typeof operations>(
      "@cogni/shared-knowledge-store/adapters/doltgres"
    );
    const before = await snapshot();
    vi.mocked(operations.updateDoltgresDomain).mockImplementationOnce(
      (query, id, data) =>
        actual.updateDoltgresDomain(
          (sql) =>
            query(
              sql.startsWith("UPDATE ")
                ? "SELECT * FROM operator_absent_relation"
                : sql
            ),
          id,
          data
        )
    );
    let observed: unknown;
    const update = store.updateDomain.bind(store);
    const observer = vi
      .spyOn(store, "updateDomain")
      .mockImplementation(async (id, data) => {
        try {
          return await update(id, data);
        } catch (error) {
          observed = error;
          throw error;
        }
      });
    const response = await handlers.handleUpdate(
      patch({ name: "Native failure" }),
      "demo",
      principal
    );
    expect(observed).toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    expect(response.status).toBe(409);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      errorCode: "knowledge_write_outcome_unknown",
      retryable: false,
      operationId: "domain.update:demo",
    });
    expect(receipt.branch).toMatch(/^dolt-op\//);
    expect(await snapshot()).toEqual(before);
    console.info(
      JSON.stringify({
        receipt: "operator-domain-native-unknown",
        operationId: receipt.operationId,
        branch: receipt.branch,
        head: before.head,
      })
    );
    observer.mockRestore();
  });
  it("deletes an empty domain through the installed helper with one private admission", async () => {
    const admission = vi.spyOn(writer, "run");
    const response = await handlers.handleDelete("demo", principal);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "demo", deleted: true });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(await store.getDomain("demo")).toBeNull();
    admission.mockRestore();
  });
});
