// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-http.test`
 * Purpose: Pin the private actuator wire contract — authentication, strict schemas, and the
 *   stable code→status mapping a Crossplane composition will branch on.
 * Scope: Dispatcher unit tests plus one real socket round-trip through the server factory.
 *   Does NOT reach the Akash Console or a database.
 * Invariants: no unauthenticated mutation may ever reach the actuator; no migration state may
 *   ever refuse one (task.5135).
 * Side-effects: IO (one loopback HTTP server on an ephemeral port)
 * Links: ./akash-tx-http, @contracts/compute.akash-tx.v1, task.5095
 * @internal
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AkashTxActuatorPort } from "@/ports";
import { AkashTxError } from "@/ports";

import {
  AKASH_TX_SECRET_ENVELOPE_CLOSE,
  AKASH_TX_SECRET_ENVELOPE_OPEN,
  createAkashTxActuatorServer,
  createAkashTxDispatcher,
  resolveInjectedSecretEnvelopes,
} from "./akash-tx-http";

const TOKEN = "test-token";
const AUTH = `Bearer ${TOKEN}`;

/** The RELEASE step, as it travels on an OBSERVE. Never on a mutation (task.5135). */
const MIGRATION_STEP = {
  profile: "cogni-node-app-v1",
  bundleDigest: `sha256:${"a".repeat(64)}`,
  image: `ghcr.io/cogni-dao/toks9@sha256:${"b".repeat(64)}`,
  doltgres: false,
};

const IDENTITY = {
  nodeId: "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60",
  compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
  compositeGeneration: 3,
};

const VALID_CREATE = {
  cogniKey: "candidate-a/toks9/1",
  environment: "candidate-a",
  identity: IDENTITY,
  spec: {
    name: "toks9",
    services: [
      {
        name: "app",
        image: "ghcr.io/cogni-dao/toks9:sha-abc",
        cpuUnits: 0.5,
        memoryMi: 512,
        storageMi: 1024,
      },
    ],
  },
};

function stubActuator(
  overrides: Partial<AkashTxActuatorPort> = {}
): AkashTxActuatorPort {
  return {
    observe: async () => ({ found: false }),
    create: async () => ({
      externalName: "7001",
      state: "pending",
      endpoints: [],
      replayed: false,
      recovered: false,
    }),
    update: async () => ({
      externalName: "7001",
      state: "active",
      endpoints: [],
    }),
    delete: async () => {},
    // The sweeper is a scheduled operation, never an HTTP route: the dispatcher must expose
    // no path that reaches it, which the route-surface assertions below pin.
    sweepStaleAllocations: async () => ({
      scanned: 0,
      rolledBack: 0,
      adopted: 0,
      held: 0,
    }),
    leaseLogSources: async () => ({ sources: [], token: "", ttlSeconds: 0 }),
    ...overrides,
  };
}

function dispatcherFor(actuator: AkashTxActuatorPort) {
  return createAkashTxDispatcher({ actuator, token: TOKEN });
}

describe("akash-tx dispatcher", () => {
  it("refuses to construct without a bearer token", () => {
    expect(() =>
      createAkashTxDispatcher({ actuator: stubActuator(), token: "" })
    ).toThrow(/bearer token/);
  });

  it("rejects an unauthenticated mutation", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: "Bearer nope",
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(401);
  });

  it("answers health without authentication and without provider IO", async () => {
    let observed = 0;
    const dispatch = dispatcherFor(
      stubActuator({
        observe: async () => {
          observed += 1;
          return { found: false };
        },
      })
    );
    const response = await dispatch({ method: "GET", path: "/healthz" });
    expect(response).toEqual({ status: 200, body: { status: "ok" } });
    expect(observed).toBe(0);
  });

  it("creates through the actuator and echoes the typed result", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      externalName: "7001",
      replayed: false,
    });
  });

  it("rejects an unknown key instead of silently ignoring it", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify({ ...VALID_CREATE, deposit: 500 }),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request" });
  });

  it("rejects a malformed body", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("maps a wallet block to 409 and names the owner", async () => {
    const dispatch = dispatcherFor(
      stubActuator({
        create: async () => {
          throw new AkashTxError(
            "wallet_allocation_blocked",
            "another allocation holds the wallet slot",
            "other-key"
          );
        },
      })
    );
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "wallet_allocation_blocked",
      ownerCogniKey: "other-key",
    });
  });

  it("logs every AkashTxError response so a failed op is visible in-cluster (bug.5221)", async () => {
    const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const dispatch = createAkashTxDispatcher({
      actuator: stubActuator({
        create: async () => {
          throw new AkashTxError(
            "provider_unavailable",
            "Console request failed with HTTP 401"
          );
        },
      }),
      token: TOKEN,
      log: {
        info: () => {},
        warn: (fields: Record<string, unknown>, msg: string) =>
          warns.push({ fields, msg }),
        error: () => {},
      },
    });
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      msg: "akash_tx_http_op_failed",
      fields: {
        path: "/v1/akash/create",
        code: "provider_unavailable",
        causeMessage: "Console request failed with HTTP 401",
      },
    });
  });

  it("maps an unresolved allocation to 409 and an unknown outcome to 502", async () => {
    const unresolved = dispatcherFor(
      stubActuator({
        create: async () => {
          throw new AkashTxError("allocation_unresolved", "unresolved");
        },
      })
    );
    const unknown = dispatcherFor(
      stubActuator({
        create: async () => {
          throw new AkashTxError("outcome_unknown", "unknown");
        },
      })
    );
    const body = JSON.stringify(VALID_CREATE);
    expect(
      (
        await unresolved({
          method: "POST",
          path: "/v1/akash/create",
          authorization: AUTH,
          body,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await unknown({
          method: "POST",
          path: "/v1/akash/create",
          authorization: AUTH,
          body,
        })
      ).status
    ).toBe(502);
  });

  it("maps a rolled-back allocation to a RETRYABLE 409, and exposes no sweep route", async () => {
    // bug.5192: the Composition treats 409 as retryable (`Progressing`) and anything else as
    // Failed. A settled-and-freed receipt is precisely "come back with the same key", so the
    // very next reconcile creates instead of wedging.
    const dispatch = dispatcherFor(
      stubActuator({
        create: async () => {
          throw new AkashTxError("allocation_rolled_back", "settled, retry");
        },
      })
    );
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "allocation_rolled_back",
    });

    // The sweeper is scheduled in the composition root, never reachable over the wire: it
    // settles receipts, and nothing outside this process gets to ask for that.
    for (const path of ["/v1/akash/sweep", "/v1/akash/sweepStaleAllocations"]) {
      expect(
        (
          await dispatch({
            method: "POST",
            path,
            authorization: AUTH,
            body: "{}",
          })
        ).status
      ).toBe(404);
    }
  });

  it("accepts a create that states NO migration at all (task.5135)", async () => {
    // The inverse of the pre-task.5135 assertion, which required the field and 400'd without
    // it. Buying compute has nothing to prove about a database.
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });
    expect(response.status).toBe(200);
  });

  it("accepts an update that states NO migration at all", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/update",
      authorization: AUTH,
      body: JSON.stringify({ ...VALID_CREATE, externalName: "7001" }),
    });
    expect(response.status).toBe(200);
  });

  it("still ACCEPTS the deprecated migration field, and drops it", async () => {
    // Zero-downtime: a Composition rendered before the rematerialize still sends it, and 400ing
    // the whole fleet mid-rollout would be worse than the bug being fixed. It must never reach
    // the actuator.
    let seen: unknown;
    const dispatch = dispatcherFor(
      stubActuator({
        create: async (input) => {
          seen = input;
          return {
            externalName: "7001",
            state: "active",
            endpoints: [],
            replayed: false,
            recovered: false,
          };
        },
      })
    );
    for (const policy of ["Skip", "RequireBeforeTransaction"]) {
      const response = await dispatch({
        method: "POST",
        path: "/v1/akash/create",
        authorization: AUTH,
        body: JSON.stringify({ ...VALID_CREATE, migration: { policy } }),
      });
      expect(response.status).toBe(200);
      expect(seen).not.toHaveProperty("migration");
    }
  });

  it("refuses a deprecated migration policy it does not know", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify({
        ...VALID_CREATE,
        migration: { policy: "TrustMe" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("carries the release step, its workload and its environment on OBSERVE", async () => {
    let seen: unknown;
    const dispatch = dispatcherFor(
      stubActuator({
        observe: async (input) => {
          seen = input;
          return { found: false, migration: { phase: "running" } };
        },
      })
    );
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/observe",
      authorization: AUTH,
      body: JSON.stringify({
        cogniKey: VALID_CREATE.cogniKey,
        workload: "toks9",
        environment: "candidate-a",
        migration: MIGRATION_STEP,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ migration: { phase: "running" } });
    expect(seen).toMatchObject({
      workload: "toks9",
      environment: "candidate-a",
      migration: MIGRATION_STEP,
    });
  });

  it("refuses a release step that names no digest", async () => {
    // The step is a strict object: an under-specified one is a schema error, not a silent pass.
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/observe",
      authorization: AUTH,
      body: JSON.stringify({
        cogniKey: VALID_CREATE.cogniKey,
        migration: { profile: "cogni-node-app-v1" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("has no status code a migration can reach", async () => {
    // The three migration refusals (409/422/503) are GONE from the error union. A database can
    // no longer answer a paid request at all, so there is nothing left to map.
    const source = readFileSync(
      path.join(__dirname, "akash-tx-http.ts"),
      "utf8"
    );
    const table = source.slice(
      source.indexOf("STATUS_BY_CODE"),
      source.indexOf("export interface AkashTxHttpRequest")
    );
    expect(table).not.toMatch(/migration_/);
  });

  it("404s an unknown operation", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/close-everything",
      authorization: AUTH,
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("requires an external name to delete", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/delete",
      authorization: AUTH,
      body: JSON.stringify({ cogniKey: "k1" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("akash-tx server binding", () => {
  const server = createAkashTxActuatorServer({
    actuator: stubActuator(),
    token: TOKEN,
  });

  afterAll(() => {
    server.close();
  });

  it("serves the dispatcher over a real socket", async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;

    const created = await fetch(`http://127.0.0.1:${port}/v1/akash/create`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify(VALID_CREATE),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ externalName: "7001" });

    const denied = await fetch(`http://127.0.0.1:${port}/v1/akash/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_CREATE),
    });
    expect(denied.status).toBe(401);
  });
});

describe("akash-tx identity on the wire (task.5103)", () => {
  it("400s a create that will not name the consuming node", async () => {
    let created = 0;
    const dispatch = dispatcherFor(
      stubActuator({
        create: async () => {
          created += 1;
          throw new Error("unreachable");
        },
      })
    );
    const { identity: _omitted, ...anonymous } = VALID_CREATE;

    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(anonymous),
    });

    expect(response.status).toBe(400);
    // The refusal happens at the wire; the wallet writer is never reached.
    expect(created).toBe(0);
  });

  it("400s an identity whose nodeId is not a uuid", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify({
        ...VALID_CREATE,
        identity: { ...IDENTITY, nodeId: "toks9" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("maps an identity conflict to a terminal 422, never a retryable 409", async () => {
    const dispatch = dispatcherFor(
      stubActuator({
        create: async () => {
          throw new AkashTxError(
            "identity_conflict",
            "this cogniKey is bound to a different node"
          );
        },
      })
    );

    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/create",
      authorization: AUTH,
      body: JSON.stringify(VALID_CREATE),
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "identity_conflict" });
  });
});

describe("lease-log-sources route (bug.5240)", () => {
  it("dispatches an authorized read and returns the snapshot", async () => {
    const sources = [
      {
        nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e",
        workload: "poly",
        environment: "candidate-a",
        dseq: "7001",
        gseq: 1,
        oseq: 1,
        providerAccount: "akash1provider",
        providerHostUri: "https://provider.example.com:8443",
        services: ["app", "paper-trader"],
      },
    ];
    const dispatch = dispatcherFor(
      stubActuator({
        leaseLogSources: async (input) => {
          expect(input).toEqual({ environment: "candidate-a" });
          return { sources, token: "jwt", ttlSeconds: 300 };
        },
      })
    );
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/lease-log-sources",
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ environment: "candidate-a" }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ token: "jwt", ttlSeconds: 300 });
  });

  it("rejects an unauthenticated read", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/lease-log-sources",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a malformed input", async () => {
    const dispatch = dispatcherFor(stubActuator());
    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/lease-log-sources",
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ limit: 0 }),
    });
    expect(response.status).toBe(400);
  });
});

/**
 * JSON-SAFE SECRET ENVELOPE (bug.5262).
 *
 * provider-http resolves a `{{ name:ns:key }}` placeholder with a RAW `strings.ReplaceAll` of the
 * secret bytes into the already-marshaled JSON body, as the final step after its jq transform. A
 * secret value carrying `"`, `\` or a control char therefore splices in UNESCAPED and turns the
 * body into invalid JSON — before the fix this dispatcher's `JSON.parse` threw `body must be JSON`
 * and 400'd the deploy (poly prod POLYGON_RPC_URL / PRIVY_*). The Composition now wraps each
 * body-embedded placeholder in a sentinel envelope; this transport step re-escapes the raw bytes
 * between the sentinels before parsing.
 */
describe("JSON-safe secret envelope (bug.5262)", () => {
  // A value that hits every JSON hazard at once: a literal double-quote, a real newline (control
  // char), and a lone backslash forming an invalid escape (`\p`).
  const NASTY_SECRET = 'he said "hi"\n\\path';

  /** Wrap a resolved secret value the way the raw provider-http splice lands it in the body. */
  const wrap = (value: string): string =>
    `${AKASH_TX_SECRET_ENVELOPE_OPEN}${value}${AKASH_TX_SECRET_ENVELOPE_CLOSE}`;

  it("re-escapes a raw splice that would otherwise be invalid JSON", () => {
    const rawBody = `{"env":{"POLYGON_RPC_URL":"${wrap(NASTY_SECRET)}"}}`;
    // The un-decoded body is genuinely invalid — the quote/newline/backslash break it.
    expect(() => JSON.parse(rawBody)).toThrow();
    const parsed = JSON.parse(resolveInjectedSecretEnvelopes(rawBody));
    expect(parsed.env.POLYGON_RPC_URL).toBe(NASTY_SECRET);
  });

  it("handles multiple envelopes and is a no-op without any", () => {
    const body = `{"a":"${wrap('x"y\\z')}","b":"${wrap("p\tq")}","c":"plain"}`;
    const parsed = JSON.parse(resolveInjectedSecretEnvelopes(body));
    expect(parsed).toEqual({ a: 'x"y\\z', b: "p\tq", c: "plain" });
    const clean = JSON.stringify({ cogniKey: "candidate-a/toks9/1" });
    expect(resolveInjectedSecretEnvelopes(clean)).toBe(clean);
  });

  it("parses the EXACT one-service empty-bindings UPDATE body a raw backslash+quote secret would break", async () => {
    let received: { spec?: { services: { env?: Record<string, string> }[] } } =
      {};
    const dispatch = dispatcherFor(
      stubActuator({
        update: async (input) => {
          received = input;
          return { externalName: "7001", state: "active", endpoints: [] };
        },
      })
    );

    // The wire body exactly as the Composition emits it for a single `app` service whose bindings
    // are empty (no paper-trader sidecar): `env` carries the sentinel-wrapped secret placeholder,
    // and provider-http has already spliced the raw secret VALUE between the sentinels.
    const updateBody = {
      cogniKey: "xcw:cogni-production:poly:0",
      externalName: "7001",
      environment: "production",
      identity: IDENTITY,
      spec: {
        name: "poly",
        services: [
          {
            name: "app",
            image: `ghcr.io/cogni-dao/poly@sha256:${"c".repeat(64)}`,
            cpuUnits: 0.5,
            memoryMi: 512,
            storageMi: 1024,
            env: {
              HOST: "app",
              POLYGON_RPC_URL: "__SECRET_POLYGON__",
            },
          },
        ],
      },
    };
    // Serialize, then simulate provider-http's raw, unescaped splice of the real value.
    const wireBody = JSON.stringify(updateBody).replace(
      "__SECRET_POLYGON__",
      wrap(NASTY_SECRET)
    );
    // Sanity: that raw wire body really is invalid JSON, i.e. this is the failure being fixed.
    expect(() => JSON.parse(wireBody)).toThrow();

    const response = await dispatch({
      method: "POST",
      path: "/v1/akash/update",
      authorization: AUTH,
      body: wireBody,
    });

    // Before the fix this was 400 {"code":"invalid_request","message":"body must be JSON"}.
    expect(response.status).toBe(200);
    expect(received.spec?.services[0]?.env?.POLYGON_RPC_URL).toBe(NASTY_SECRET);
  });
});
