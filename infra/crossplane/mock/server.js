// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@infra/crossplane/mock/server`
 * Purpose: In-memory mock of the Akash Console compute API for the provider-akash kind demo, serving the by-key adoption lookup the crash-safe Observe path relies on.
 * Scope: Local demo test-double only; no real escrow, no external network, not production.
 * Invariants: Idempotent on the deterministic node key — a replayed create returns the same lease, never a second.
 * Side-effects: IO (in-memory store; an optional HTTP listener when run as a standalone server).
 * Links: infra/crossplane/README.md, infra/crossplane/provider-akash/internal/console/client.go
 * @internal
 */
//
// Mock Akash Console compute API for the provider-akash demo. Adds the ONE route
// the custom provider's crash-safe adoption path needs (the provider-http spike
// that preceded this is in git history + Dolt `crossplane-akash-spike-proven`):
//
//   GET /api/v1/compute/deployments?nodeId=<key>  -> { deployment: <active|null> }
//
// This is the list-by-deterministic-key ("find by owner/key") seam the provider
// calls in Observe to ADOPT a deployment whose lease id (external-name) was lost
// to a crash — instead of minting a second, double-paid lease.
//
// Full route set (all authenticated except /healthz and /debug/state):
//   POST   /api/v1/compute/deployments             provision (idempotent on nodeId)
//   GET    /api/v1/compute/deployments?nodeId=<k>  ADOPTION lookup by key
//   GET    /api/v1/compute/deployments/<leaseId>   observe one
//   PUT    /api/v1/compute/deployments/<leaseId>   update in place (same lease)
//   DELETE /api/v1/compute/deployments/<leaseId>   release (idempotent)
//   GET    /api/v1/compute/balances                ComputeBalance[]
//   GET    /debug/state                            demo introspection (no auth)
//
// The no-double-spend invariant: a repeated provision of the same nodeId, OR an
// adoption lookup by nodeId, returns the SAME leaseId — never a second lease.
// Mirrors the operator's allocationCursor/findAllocationSince adoption.
//
// Zero npm dependencies (Node built-in http only): runs in a bare node:alpine
// container from a ConfigMap, and is unit-testable with `node --test`.

"use strict";

const http = require("http");
const crypto = require("crypto");

const PROVIDER = "akash";
const DSEQ_START = 1_000_000;

function createStore() {
  return {
    byLease: new Map(),
    byNode: new Map(),
    nextDseq: DSEQ_START,
    provisionAttempts: 0,
    updateCount: 0,
    deleteCount: 0,
    mintedLeaseIds: new Set(),
  };
}

function specHashOf(body) {
  const canonical = JSON.stringify({
    publicHost: body.publicHost ?? null,
    services: body.services ?? [],
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function provisionOutput(record) {
  return {
    provider: record.provider,
    leaseId: record.leaseId,
    state: record.state,
    endpoints: record.endpoints,
    nodeId: record.nodeId,
    publicHost: record.publicHost,
    services: record.services,
    specHash: record.specHash,
  };
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

function isAuthorized(req) {
  const h = req.headers["authorization"];
  return typeof h === "string" && h.trim().length > 0;
}

function handle(store, method, url, headers, body) {
  const u = new URL(url, "http://mock");
  const path = u.pathname;

  if (method === "GET" && path === "/healthz") {
    return { status: 200, body: { ok: true } };
  }
  if (method === "GET" && path === "/debug/state") {
    return {
      status: 200,
      body: {
        provisionAttempts: store.provisionAttempts,
        distinctLeasesMinted: store.mintedLeaseIds.size,
        activeLeaseIds: [...store.byLease.values()]
          .filter((r) => r.state !== "closed")
          .map((r) => r.leaseId),
        updateCount: store.updateCount,
        deleteCount: store.deleteCount,
      },
    };
  }

  if (!headers.authorized) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (path === "/api/v1/compute/balances" && method === "GET") {
    const active = [...store.byLease.values()].filter((r) => r.state !== "closed").length;
    return {
      status: 200,
      body: {
        balances: [
          {
            provider: PROVIDER,
            accountId: "akash1mockaccount000000000000000000000000",
            currency: "USD",
            remaining: Number((100 - active * 0.5).toFixed(2)),
            asOf: new Date().toISOString(),
            estimatedDaysRemaining: null,
          },
        ],
      },
    };
  }

  // Collection endpoint.
  if (path === "/api/v1/compute/deployments") {
    // ADOPTION lookup by deterministic key. This is the seam the custom
    // provider's Observe uses to recover a deployment whose external-name was
    // lost to a crash — returns the SAME lease, never mints a new one.
    if (method === "GET") {
      const nodeId = u.searchParams.get("nodeId");
      if (!nodeId) {
        return { status: 400, body: { error: "invalid_query", message: "nodeId required" } };
      }
      const leaseId = store.byNode.get(nodeId);
      const rec = leaseId ? store.byLease.get(leaseId) : null;
      if (!rec || rec.state === "closed") {
        return { status: 200, body: { deployment: null } };
      }
      return { status: 200, body: { deployment: provisionOutput(rec) } };
    }

    // Provision.
    if (method === "POST") {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return { status: 400, body: { error: "invalid_body" } };
      }
      const { nodeId, name, publicHost, services } = parsed;
      if (!nodeId || !name || !publicHost || !Array.isArray(services) || services.length === 0) {
        return {
          status: 400,
          body: { error: "invalid_body", message: "nodeId,name,publicHost,services required" },
        };
      }
      store.provisionAttempts += 1;

      // IDEMPOTENCY / no-double-spend on nodeId (the crash-safety crux).
      const existingLease = store.byNode.get(nodeId);
      if (existingLease && store.byLease.has(existingLease)) {
        const rec = store.byLease.get(existingLease);
        if (rec.state !== "closed") {
          return { status: 200, body: provisionOutput(rec) };
        }
      }

      const leaseId = String(store.nextDseq++);
      const record = {
        provider: PROVIDER,
        leaseId,
        nodeId,
        name,
        publicHost,
        services,
        specHash: specHashOf(parsed),
        state: "active",
        endpoints: [`https://${publicHost}`],
        createdAt: new Date().toISOString(),
      };
      store.byLease.set(leaseId, record);
      store.byNode.set(nodeId, leaseId);
      store.mintedLeaseIds.add(leaseId);
      return { status: 200, body: provisionOutput(record) };
    }
  }

  // Item endpoint.
  const m = path.match(/^\/api\/v1\/compute\/deployments\/([^/]+)$/);
  if (m) {
    const leaseId = decodeURIComponent(m[1]);
    const record = store.byLease.get(leaseId);

    if (method === "GET") {
      if (!record || record.state === "closed") {
        return { status: 404, body: { error: "not_found" } };
      }
      return { status: 200, body: provisionOutput(record) };
    }
    if (method === "PUT") {
      if (!record || record.state === "closed") {
        return { status: 404, body: { error: "not_found" } };
      }
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return { status: 400, body: { error: "invalid_body" } };
      }
      if (parsed.publicHost) record.publicHost = parsed.publicHost;
      if (Array.isArray(parsed.services)) record.services = parsed.services;
      record.specHash = specHashOf(record);
      record.endpoints = [`https://${record.publicHost}`];
      record.state = "active";
      store.updateCount += 1;
      return { status: 200, body: provisionOutput(record) };
    }
    if (method === "DELETE") {
      if (record && record.state !== "closed") {
        record.state = "closed";
        store.byNode.delete(record.nodeId);
        store.deleteCount += 1;
      }
      return { status: 200, body: { leaseId, state: "closed" } };
    }
  }

  return { status: 404, body: { error: "route_not_found", path, method } };
}

function createServer(store = createStore()) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = { authorized: isAuthorized(req) };
      let result;
      try {
        result = handle(store, req.method, req.url, headers, body);
      } catch (err) {
        result = { status: 500, body: { error: "internal", message: String(err && err.message) } };
      }
      json(res, result.status, result.body);
    });
  });
  server.store = store;
  return server;
}

module.exports = { createStore, handle, createServer, specHashOf };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`mock akash console compute API listening on :${port}`);
  });
}
