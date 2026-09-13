// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-http.test`
 * Purpose: Pin the private actuator wire contract — authentication, strict schemas, and the
 *   stable code→status mapping a Crossplane composition will branch on.
 * Scope: Dispatcher unit tests plus one real socket round-trip through the server factory.
 *   Does NOT reach the Akash Console or a database.
 * Invariants: no unauthenticated mutation may ever reach the actuator.
 * Side-effects: IO (one loopback HTTP server on an ephemeral port)
 * Links: ./akash-tx-http, @contracts/compute.akash-tx.v1, task.5095
 * @internal
 */

import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import type { AkashTxActuatorPort } from "@/ports";
import { AkashTxError } from "@/ports";

import {
  createAkashTxActuatorServer,
  createAkashTxDispatcher,
} from "./akash-tx-http";

const TOKEN = "test-token";
const AUTH = `Bearer ${TOKEN}`;

const VALID_CREATE = {
  cogniKey: "candidate-a/toks9/1",
  environment: "candidate-a",
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
