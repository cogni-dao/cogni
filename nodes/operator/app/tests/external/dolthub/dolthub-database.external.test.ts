// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/dolthub/dolthub-database.external`
 * Purpose: Prove DoltHub can create a node knowledge database and serve initialized contents over SQL.
 * Scope: Live DoltHub API only; creates a unique repo and does not delete it because no delete endpoint is documented.
 * Invariants: Requires DOLTHUB_API_TOKEN and explicit DOLTHUB_EXTERNAL_TEST_OWNER; skips without them.
 * Side-effects: IO (DoltHub API) and durable repo creation under the configured test owner.
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, https://docs.dolthub.com/products/dolthub/api/database
 * @internal
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const DOLTHUB_API_TOKEN = process.env.DOLTHUB_API_TOKEN ?? "";
const TEST_OWNER = process.env.DOLTHUB_EXTERNAL_TEST_OWNER ?? "";

const DATABASE_ENDPOINT = "https://www.dolthub.com/api/v1alpha1/database";
const SQL_API_ROOT = "https://www.dolthub.com/api/v1alpha1";
const MAX_POLL_ATTEMPTS = 30;
const POLL_DELAY_MS = 2_000;

const hasRequiredEnv = Boolean(DOLTHUB_API_TOKEN && TEST_OWNER);

type JsonObject = Record<string, unknown>;

function newTargetRepoName(): string {
  const stamp = Date.now().toString(36);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  return `knowledge-e2e-${stamp}-${suffix}`;
}

function compactMessage(body: JsonObject): string {
  return [body.status, body.error, body.message, body.query_execution_message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`DoltHub returned non-object JSON: ${text}`);
  }
  return parsed as JsonObject;
}

async function createDatabase(targetRepo: string): Promise<JsonObject> {
  const response = await fetch(DATABASE_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `token ${DOLTHUB_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ownerName: TEST_OWNER,
      repoName: targetRepo,
      description: `Cogni external formation test ${targetRepo}`,
      visibility: "public",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`DoltHub database create failed: ${compactMessage(body)}`);
  }
  return body;
}

async function writeBootstrapTable(targetRepo: string): Promise<string> {
  const url = new URL(
    `${SQL_API_ROOT}/${TEST_OWNER}/${targetRepo}/write/main/main`
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `token ${DOLTHUB_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query:
        "CREATE TABLE cogni_external_probe AS SELECT 1 AS id, 'ok' AS label",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`DoltHub SQL write failed: ${compactMessage(body)}`);
  }
  const operationName = body.operation_name;
  if (typeof operationName !== "string" || operationName.length === 0) {
    throw new Error("DoltHub SQL write response missing operation_name");
  }
  return operationName;
}

async function pollWrite(
  targetRepo: string,
  operationName: string
): Promise<JsonObject> {
  const url = new URL(`${SQL_API_ROOT}/${TEST_OWNER}/${targetRepo}/write`);
  url.searchParams.set("operationName", operationName);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `token ${DOLTHUB_API_TOKEN}` },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`DoltHub SQL write poll failed: ${compactMessage(body)}`);
    }
    if (body.done === true) {
      const details =
        body.res_details &&
        typeof body.res_details === "object" &&
        !Array.isArray(body.res_details)
          ? (body.res_details as JsonObject)
          : {};
      if (details.query_execution_status !== "Success") {
        throw new Error(
          `DoltHub SQL write completed non-success: ${compactMessage(details)}`
        );
      }
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
  }

  throw new Error(`DoltHub SQL write timed out for operation ${operationName}`);
}

async function readProbeRow(targetRepo: string): Promise<JsonObject> {
  const url = new URL(`${SQL_API_ROOT}/${TEST_OWNER}/${targetRepo}`);
  url.searchParams.set(
    "q",
    "SELECT label FROM cogni_external_probe WHERE id = 1"
  );
  const response = await fetch(url);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`DoltHub SQL read failed: ${compactMessage(body)}`);
  }
  return body;
}

describe.skipIf(!hasRequiredEnv)(
  "DoltHub knowledge database formation (external)",
  () => {
    it("creates a uniquely named database and proves initialized contents are queryable", async () => {
      const targetRepo = newTargetRepoName();

      const created = await createDatabase(targetRepo);
      expect(created.status).toBe("Success");
      expect(created.repository_owner).toBe(TEST_OWNER);
      expect(created.repository_name).toBe(targetRepo);

      const operationName = await writeBootstrapTable(targetRepo);
      await pollWrite(targetRepo, operationName);

      const query = await readProbeRow(targetRepo);
      expect(query.query_execution_status).toBe("Success");
      expect(query.repository_owner).toBe(TEST_OWNER);
      expect(query.repository_name).toBe(targetRepo);
      expect(query.rows).toEqual([{ label: "ok" }]);

      console.log(`DoltHub external test created ${TEST_OWNER}/${targetRepo}`);
    }, 120_000);
  }
);
