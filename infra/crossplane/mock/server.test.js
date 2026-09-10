// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@infra/crossplane/mock/server.test`
 * Purpose: Unit tests for the mock Akash Console compute API, proving the no-double-spend idempotency and the by-key adoption lookup the crash-safe provider Observe depends on.
 * Scope: Local demo test-double only; runs on the Node built-in test runner and does not hit the network.
 * Invariants: A replayed create returns the same lease (distinct-lease count unchanged); release is idempotent; by-key lookup is deterministic.
 * Side-effects: IO (spins the in-memory store; asserts via the Node test runner).
 * Links: infra/crossplane/mock/server.js, infra/crossplane/README.md
 * @internal
 */
//
// Unit tests for the mock Akash Console compute API.
// Run: node --test   (Node >= 18, built-in test runner)
//
// Proves the contract the provider relies on — the no-double-spend idempotency
// AND the by-key adoption lookup the crash-safe Observe uses.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore, handle } = require("./server.js");

const AUTH = { authorized: true };
const NOAUTH = { authorized: false };
const NODE_ID = "11111111-1111-1111-1111-111111111111";

const sampleBody = (over = {}) =>
  JSON.stringify({
    nodeId: NODE_ID,
    name: "demo-node-app",
    publicHost: "demo.example.com",
    services: [
      {
        name: "app",
        image: "ghcr.io/cogni/demo@sha256:" + "a".repeat(64),
        cpuUnits: 0.5,
        memoryMi: 512,
        storageMi: 1024,
        port: 3000,
        visibility: "public",
      },
    ],
    ...over,
  });

test("POST provisions and returns a ProvisionOutput with a leaseId", () => {
  const store = createStore();
  const r = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, "akash");
  assert.match(r.body.leaseId, /^\d+$/);
  assert.equal(r.body.state, "active");
  assert.deepEqual(r.body.endpoints, ["https://demo.example.com"]);
});

test("no-double-spend: repeated POST for the same nodeId returns the SAME leaseId", () => {
  const store = createStore();
  const first = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const second = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const third = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());

  assert.equal(first.body.leaseId, second.body.leaseId);
  assert.equal(second.body.leaseId, third.body.leaseId);

  const dbg = handle(store, "GET", "/debug/state", NOAUTH, "");
  assert.equal(dbg.body.provisionAttempts, 3);
  assert.equal(dbg.body.distinctLeasesMinted, 1);
  assert.equal(dbg.body.activeLeaseIds.length, 1);
});

test("ADOPTION: GET ?nodeId= returns the active deployment for a known key", () => {
  const store = createStore();
  const created = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const found = handle(store, "GET", `/api/v1/compute/deployments?nodeId=${NODE_ID}`, AUTH, "");
  assert.equal(found.status, 200);
  assert.ok(found.body.deployment, "expected a deployment for the known key");
  assert.equal(found.body.deployment.leaseId, created.body.leaseId);
});

test("ADOPTION: GET ?nodeId= returns null for an unknown key (=> provider creates)", () => {
  const store = createStore();
  const found = handle(store, "GET", "/api/v1/compute/deployments?nodeId=unknown-key", AUTH, "");
  assert.equal(found.status, 200);
  assert.equal(found.body.deployment, null);
});

test("ADOPTION: after release, GET ?nodeId= returns null (no stale adoption)", () => {
  const store = createStore();
  const created = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  handle(store, "DELETE", `/api/v1/compute/deployments/${created.body.leaseId}`, AUTH, "");
  const found = handle(store, "GET", `/api/v1/compute/deployments?nodeId=${NODE_ID}`, AUTH, "");
  assert.equal(found.body.deployment, null);
});

test("ADOPTION: GET without nodeId is a 400", () => {
  const store = createStore();
  const r = handle(store, "GET", "/api/v1/compute/deployments", AUTH, "");
  assert.equal(r.status, 400);
});

test("distinct nodeIds get distinct leases", () => {
  const store = createStore();
  const a = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const b = handle(
    store,
    "POST",
    "/api/v1/compute/deployments",
    AUTH,
    sampleBody({ nodeId: "22222222-2222-2222-2222-222222222222" })
  );
  assert.notEqual(a.body.leaseId, b.body.leaseId);
  const dbg = handle(store, "GET", "/debug/state", NOAUTH, "");
  assert.equal(dbg.body.distinctLeasesMinted, 2);
});

test("GET returns status for a known lease and 404 for unknown", () => {
  const store = createStore();
  const created = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const ok = handle(store, "GET", `/api/v1/compute/deployments/${created.body.leaseId}`, AUTH, "");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.leaseId, created.body.leaseId);

  const missing = handle(store, "GET", "/api/v1/compute/deployments/does-not-exist", AUTH, "");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not_found");
});

test("PUT updates in place and keeps the same leaseId; specHash changes on drift", () => {
  const store = createStore();
  const created = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const before = created.body.specHash;

  const drifted = sampleBody({
    services: [
      {
        name: "app",
        image: "ghcr.io/cogni/demo@sha256:" + "a".repeat(64),
        cpuUnits: 0.5,
        memoryMi: 1024,
        storageMi: 1024,
        port: 3000,
        visibility: "public",
      },
    ],
  });
  const updated = handle(store, "PUT", `/api/v1/compute/deployments/${created.body.leaseId}`, AUTH, drifted);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.leaseId, created.body.leaseId);
  assert.notEqual(updated.body.specHash, before);
  assert.equal(updated.body.services[0].memoryMi, 1024);
});

test("DELETE releases the lease; subsequent GET is 404; balance recovers", () => {
  const store = createStore();
  const created = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  const before = handle(store, "GET", "/api/v1/compute/balances", AUTH, "");
  assert.equal(before.body.balances[0].remaining, 99.5);

  const del = handle(store, "DELETE", `/api/v1/compute/deployments/${created.body.leaseId}`, AUTH, "");
  assert.equal(del.status, 200);
  assert.equal(del.body.state, "closed");

  const after = handle(store, "GET", `/api/v1/compute/deployments/${created.body.leaseId}`, AUTH, "");
  assert.equal(after.status, 404);

  const bal = handle(store, "GET", "/api/v1/compute/balances", AUTH, "");
  assert.equal(bal.body.balances[0].remaining, 100);
});

test("DELETE is idempotent for an unknown lease", () => {
  const store = createStore();
  const del = handle(store, "DELETE", "/api/v1/compute/deployments/nope", AUTH, "");
  assert.equal(del.status, 200);
});

test("after release, a new POST for the same nodeId mints a NEW lease", () => {
  const store = createStore();
  const first = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  handle(store, "DELETE", `/api/v1/compute/deployments/${first.body.leaseId}`, AUTH, "");
  const second = handle(store, "POST", "/api/v1/compute/deployments", AUTH, sampleBody());
  assert.notEqual(first.body.leaseId, second.body.leaseId);
});

test("unauthenticated requests are rejected", () => {
  const store = createStore();
  const r = handle(store, "POST", "/api/v1/compute/deployments", NOAUTH, sampleBody());
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "unauthorized");
});

test("balances returns a ComputeBalance shape", () => {
  const store = createStore();
  const r = handle(store, "GET", "/api/v1/compute/balances", AUTH, "");
  assert.equal(r.status, 200);
  const b = r.body.balances[0];
  for (const k of ["provider", "accountId", "currency", "remaining", "asOf", "estimatedDaysRemaining"]) {
    assert.ok(k in b, `missing ${k}`);
  }
});
