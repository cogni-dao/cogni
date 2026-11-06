// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/node-deploy/headscale.adapter`
 * Purpose: Contract test for `HeadscaleSocketAdapter` (task.5429): the client speaks the pinned v0.29.7
 *   schema, and a real `ghcr.io/juanfont/headscale:v0.29.7` (by digest) answers every port call over its
 *   unix socket with no API key.
 * Scope: Adapter <-> real Headscale only. Does not test mesh-plane rules (unit-tested over a fake port).
 * Invariants:
 *   - PINNED_SCHEMA: the vendored protos are byte-pinned (sha256 of the upstream body at tag v0.29.7) and
 *     the bundled descriptor equals them for every message and method the client uses.
 *   - SOCKET_ONLY_NO_API_KEY (HR 12): the adapter is built from a socket path only; Headscale lists zero
 *     API keys and the client schema has no method that could create one.
 *   - FAIL_CLOSED_SEED (HR 4): a fresh Headscale reports no policy (`null`); our deny-all seed and our
 *     derived policy form are accepted and read back byte for byte.
 * Side-effects: IO (Docker container, unix socket, temp dirs)
 * Notes: The container lane runs where a bind-mounted unix socket is reachable from the test process
 *   (Linux, i.e. CI). Elsewhere set HEADSCALE_CONTRACT_SOCKET to the socket of a FRESH, disposable
 *   v0.29.7 Headscale (for example bridged out of Docker Desktop), whose config uses
 *   `server_url: http://headscale:8080`, and HEADSCALE_CONTRACT_NETWORK to the Docker network on which it
 *   has the alias `headscale` (for the real-client join case); otherwise the live lane skips.
 * Links: src/adapters/server/node-deploy/headscale.adapter.ts, src/ports/node-mesh.port.ts
 * @internal
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fromJSON, loadSync } from "@grpc/proto-loader";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GO_ZERO_TIME_SECONDS,
  HEADSCALE_DESCRIPTOR,
  HeadscaleSocketAdapter,
  timestampToIso,
} from "@/adapters/server/node-deploy/headscale.adapter";
import { HEADSCALE_CLIENT_METHODS } from "@/adapters/server/node-deploy/headscale-v0.29.7.descriptor";
import {
  headscaleDeviceId,
  headscaleKeyId,
  headscaleUser,
  NodeMeshError,
} from "@/ports";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(
  __dirname,
  "../../../src/adapters/server/node-deploy/headscale-proto-v0.29.7"
);

const HEADSCALE_IMAGE =
  "ghcr.io/juanfont/headscale:v0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970";

/** sha256 of each upstream file at tag v0.29.7 (commit c9cf210b8bc84d13177e18b91f555788a44b47b6). */
const UPSTREAM_SHA256: Record<string, string> = {
  "apikey.proto":
    "21661d5f22361dacf543d3a9ecc17abae69d0b2c63b28717a8a041d43f77ae08",
  "auth.proto":
    "66a9346e948b6e292079ef0a0dad68f61b54e4c2c8dce5d737eb9ffab90c2b4a",
  "device.proto":
    "9415060e9677f7229ba85c3dd85a38ceaa3f1c1af6ebff5bd7e105d99c549238",
  "headscale.proto":
    "5778c50ed2957be5ef7530abd05873bed7f50df4cadada69aa8bf3b16d9d4e1a",
  "node.proto":
    "9f6ef1e4d0afceea4ca3ae42961be1d782961b06c472dfe808a6aee1f5eae9a3",
  "policy.proto":
    "507a69b517d9392febe6d79536dff09c85dadf64fde5d28345bad887063a0278",
  "preauthkey.proto":
    "ea502df05fcb61af218b7209f7f3d386ea4caec012fe6ea2497750b2380c7e5e",
  "user.proto":
    "5a4d7b39dd0c2f6768fd8434803c1ccef04c3f8b3a5d5f589e64c4aaf354231b",
};
const VENDOR_HEADER_LINES = 4;

/** The smallest config that boots v0.29.7 in database policy mode with the socket world-connectable. */
/** The client container reaches Headscale at this alias on the test network. */
const HEADSCALE_ALIAS = "headscale";
const LOGIN_SERVER = `http://${HEADSCALE_ALIAS}:8080`;
/** Tailscale 1.104.4, the qualified client (design: phase-2 stack), pinned by index digest. */
const TAILSCALE_IMAGE =
  "tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c";

const HEADSCALE_CONFIG = `server_url: ${LOGIN_SERVER}
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: contract
    region_name: contract
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
node:
  expiry: 0
  ephemeral:
    inactivity_timeout: 5m
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
log:
  level: info
  format: text
policy:
  mode: database
dns:
  magic_dns: false
  override_local_dns: false
  base_domain: mesh.invalid
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0777"
logtail:
  enabled: false
`;

const NODE_A = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const NODE_B = "0b9d3c2e-1111-4222-8333-944455556666";
const OWNER = headscaleUser("cogni-mesh-contract");
/** The exact policy texts mesh-policy.ts serializes (sorted keys, sorted owners, rules and ports). */
const DENY_ALL = `{"acls":[],"tagOwners":{"tag:substrate":["${OWNER}@"]}}`;
const DERIVED = `{"acls":[{"action":"accept","dst":["tag:substrate:4000,5435,6379,7233"],"proto":"tcp","src":["tag:node-${NODE_B}"]},{"action":"accept","dst":["tag:substrate:5432"],"proto":"tcp","src":["tag:node-${NODE_A}"]}],"tagOwners":{"tag:node-${NODE_B}":[],"tag:node-${NODE_A}":[],"tag:substrate":["${OWNER}@"]}}`;

const PROTO_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

describe("Headscale v0.29.7 schema pin", () => {
  it("maps Go's zero time to null, except a zero key expiration, which is already expired", () => {
    const zero = { seconds: String(GO_ZERO_TIME_SECONDS), nanos: 0 };
    expect(timestampToIso(zero)).toBeNull();
    expect(timestampToIso({ seconds: "0", nanos: 0 })).toBeNull();
    expect(timestampToIso(null)).toBeNull();
    expect(Date.parse(timestampToIso(zero, "expired") ?? "")).toBeLessThan(
      Date.now()
    );
    expect(timestampToIso({ seconds: "4102444800", nanos: 0 })).toBe(
      "2100-01-01T00:00:00.000Z"
    );
  });

  it("vendored protos are the upstream v0.29.7 bytes under a provenance header", () => {
    for (const [file, sha] of Object.entries(UPSTREAM_SHA256)) {
      const text = readFileSync(
        path.join(VENDOR, "headscale/v1", file),
        "utf8"
      );
      const lines = text.split("\n");
      expect(lines[0]).toContain("juanfont/headscale at tag v0.29.7");
      expect(lines[1]).toContain("c9cf210b8bc84d13177e18b91f555788a44b47b6");
      const body = lines.slice(VENDOR_HEADER_LINES).join("\n");
      expect(createHash("sha256").update(body).digest("hex"), file).toBe(sha);
    }
  });

  it("the bundled descriptor equals the vendored protos for every message and method it carries", () => {
    // google/api/annotations.proto only adds HTTP-gateway options; a stub keeps the vendored bytes intact.
    const stub = mkdtempSync(path.join(tmpdir(), "hs-proto-stub-"));
    try {
      mkdirSync(path.join(stub, "google/api"), { recursive: true });
      writeFileSync(
        path.join(stub, "google/api/annotations.proto"),
        'syntax = "proto3";\npackage google.api;\n'
      );
      const upstream = loadSync("headscale/v1/headscale.proto", {
        ...PROTO_OPTIONS,
        includeDirs: [stub, VENDOR],
      });
      const bundled = fromJSON(HEADSCALE_DESCRIPTOR, PROTO_OPTIONS);

      const service = "headscale.v1.HeadscaleService";
      const up = upstream[service] as unknown as Record<
        string,
        {
          path: string;
          requestType: { type: unknown };
          responseType: { type: unknown };
        }
      >;
      const ours = bundled[service] as unknown as typeof up;
      expect(Object.keys(ours).sort()).toEqual(
        [...HEADSCALE_CLIENT_METHODS].sort()
      );
      for (const method of HEADSCALE_CLIENT_METHODS) {
        expect(ours[method]?.path).toBe(up[method]?.path);
        expect(ours[method]?.requestType.type).toEqual(
          up[method]?.requestType.type
        );
        expect(ours[method]?.responseType.type).toEqual(
          up[method]?.responseType.type
        );
      }
      let messages = 0;
      for (const [name, def] of Object.entries(bundled)) {
        if (name === service) continue;
        expect((def as { type: unknown }).type, name).toEqual(
          (upstream[name] as { type: unknown } | undefined)?.type
        );
        messages += 1;
      }
      expect(messages).toBeGreaterThan(20);
      // HR 12: the client cannot create an API key or register/retag a node outside AuthRegister.
      for (const absent of [
        "CreateApiKey",
        "RegisterNode",
        "SetTags",
        "DebugCreateNode",
      ])
        expect(ours[absent]).toBeUndefined();
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});

const providedSocket = process.env.HEADSCALE_CONTRACT_SOCKET;
const liveLane = Boolean(providedSocket) || process.platform === "linux";
/** With a provided socket, the join case also needs the Docker network that Headscale's alias is on. */
const providedNetwork = process.env.HEADSCALE_CONTRACT_NETWORK;

describe.skipIf(!liveLane)(
  "HeadscaleSocketAdapter against headscale:v0.29.7",
  () => {
    let container: StartedTestContainer | undefined;
    let network: StartedNetwork | undefined;
    let socketDir: string | undefined;
    let configDir: string | undefined;
    let adapter: HeadscaleSocketAdapter;

    beforeAll(async () => {
      let socketPath = providedSocket;
      if (!socketPath) {
        // The image has no /etc/headscale; mount the config the same way the socket is shared.
        configDir = mkdtempSync(path.join(tmpdir(), "hs-cfg-"));
        writeFileSync(path.join(configDir, "config.yaml"), HEADSCALE_CONFIG);
        chmodSync(configDir, 0o755);
        chmodSync(path.join(configDir, "config.yaml"), 0o644);
        socketDir = mkdtempSync(path.join(tmpdir(), "hs-sock-"));
        chmodSync(socketDir, 0o777);
        network = await new Network().start();
        container = await new GenericContainer(HEADSCALE_IMAGE)
          .withNetwork(network)
          .withNetworkAliases(HEADSCALE_ALIAS)
          .withBindMounts([
            { source: configDir, target: "/etc/headscale", mode: "ro" },
            { source: socketDir, target: "/var/run/headscale" },
          ])
          .withCommand(["serve"])
          .start();
        socketPath = path.join(socketDir, "headscale.sock");
      }
      adapter = new HeadscaleSocketAdapter({ socketPath, timeoutMs: 5_000 });
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          if ((await adapter.health()).databaseConnectivity) break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }, 180_000);

    afterAll(async () => {
      adapter?.close();
      await container?.stop();
      await network?.stop();
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it("a fresh Headscale has no policy: getPolicy is null, not an error (HR 4)", async () => {
      expect(await adapter.getPolicy()).toBeNull();
    });

    it("accepts the deny-all seed and the derived policy and reads both back byte for byte (HR 3, 4)", async () => {
      const seeded = await adapter.setPolicy(DENY_ALL);
      expect(seeded.policy).toBe(DENY_ALL);
      expect((await adapter.getPolicy())?.policy).toBe(DENY_ALL);

      const written = await adapter.setPolicy(DERIVED);
      expect(written.policy).toBe(DERIVED);
      const back = await adapter.getPolicy();
      expect(back?.policy).toBe(DERIVED);
      expect(back?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("refuses an invalid policy with a payload-free error and keeps the last good one", async () => {
      const secretish = "tag:node-should-not-leak";
      const err = await adapter
        .setPolicy(
          `{"acls":[{"action":"accept","src":["${secretish}"],"dst":["${secretish}:1"]}]}`
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeMeshError);
      expect((err as NodeMeshError).message).not.toContain(secretish);
      expect((await adapter.getPolicy())?.policy).toBe(DERIVED);
    });

    it("creates and lists the env owner object (headscale_user)", async () => {
      const created = await adapter.createUser(OWNER);
      expect(created.headscaleUser).toBe(OWNER);
      const users = await adapter.listUsers();
      expect(users.map((u) => u.headscaleUser)).toContain(OWNER);
    });

    it("mints a reusable ephemeral node-tagged key once, lists it without its value, and expires it", async () => {
      const before = Date.now();
      const minted = await adapter.createPreAuthKey({
        tags: [`tag:node-${NODE_A}`],
        reusable: true,
        ephemeral: true,
        expiration: new Date(Date.UTC(2100, 0, 1)),
      });
      expect(minted.key.length).toBeGreaterThan(20);
      expect(minted.headscaleKeyId).toMatch(/^\d+$/);
      expect(minted.tags).toEqual([`tag:node-${NODE_A}`]);
      expect(minted.reusable).toBe(true);
      expect(minted.ephemeral).toBe(true);
      expect(minted.expiration).toBe("2100-01-01T00:00:00.000Z");

      const listed = (await adapter.listPreAuthKeys()).find(
        (k) => k.headscaleKeyId === minted.headscaleKeyId
      );
      expect(listed).toBeDefined();
      expect(listed).not.toHaveProperty("key");
      expect(Date.parse(listed?.expiration ?? "")).toBeGreaterThan(before);

      await adapter.expirePreAuthKey(minted.headscaleKeyId);
      const expired = (await adapter.listPreAuthKeys()).find(
        (k) => k.headscaleKeyId === minted.headscaleKeyId
      );
      expect(Date.parse(expired?.expiration ?? "")).toBeLessThanOrEqual(
        Date.now() + 60_000
      );
      // Expire is idempotent, including for an id Headscale never issued.
      await adapter.expirePreAuthKey(minted.headscaleKeyId);
      await adapter.expirePreAuthKey(headscaleKeyId("987654"));
    });

    it("lists no devices on a fresh tailnet; deleting an unknown device is node_not_found", async () => {
      expect(await adapter.listNodes()).toEqual([]);
      const err = await adapter
        .deleteNode(headscaleDeviceId("424242"))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeMeshError);
      expect((err as NodeMeshError).code).toBe("not_found");
      expect((err as NodeMeshError).reason).toBe("node_not_found");
    });

    it("AuthRegister for an id with no pending request approves nothing (HR 11)", async () => {
      const authId = "hs-contract-unknown-auth-id-0000000000";
      const err = await adapter
        .authRegister({ headscaleUser: OWNER, authId })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeMeshError);
      expect((err as NodeMeshError).message).not.toContain(authId);
      expect(await adapter.listNodes()).toEqual([]);
    });

    it("a real tailscale client joins with a minted node key: ListNodes maps its key id, tags and expiry; expire-then-delete removes it (HR 6)", async () => {
      const networkName = network?.getName() ?? providedNetwork;
      if (!networkName) return; // provided-socket lane without a network: nothing to join through
      const minted = await adapter.createPreAuthKey({
        tags: [`tag:node-${NODE_A}`],
        reusable: true,
        ephemeral: true,
        expiration: new Date(Date.UTC(2100, 0, 1)),
      });
      const client = await new GenericContainer(TAILSCALE_IMAGE)
        .withNetworkMode(networkName)
        .withEnvironment({
          TS_USERSPACE: "true",
          TS_AUTH_ONCE: "true",
          TS_STATE_DIR: "/tmp/tailscale",
          TS_HOSTNAME: "contract-node",
          TS_AUTHKEY: minted.key,
          TS_EXTRA_ARGS: `--login-server=${LOGIN_SERVER}`,
          TS_NO_LOGS_NO_SUPPORT: "true",
        })
        .start();
      try {
        let device:
          | Awaited<ReturnType<typeof adapter.listNodes>>[number]
          | undefined;
        const deadline = Date.now() + 90_000;
        while (!device && Date.now() < deadline) {
          device = (await adapter.listNodes()).find(
            (d) => d.headscaleKeyId === minted.headscaleKeyId
          );
          if (!device) await new Promise((r) => setTimeout(r, 1_000));
        }
        expect(device, "the client never registered").toBeDefined();
        if (!device) return;
        expect(device.tags).toEqual([`tag:node-${NODE_A}`]);
        expect(device.headscaleKeyId).toBe(minted.headscaleKeyId);
        expect(device.machineKey).toMatch(/^mkey:/);
        expect(device.nodeKey).toMatch(/^nodekey:/);
        expect(device.expiry).toBeNull(); // a tagged device never expires
        expect(device.headscaleUser).toBeNull(); // tag-owned, not user-owned

        // Revoke in the design's order: expire the key, then delete the device.
        await adapter.expirePreAuthKey(minted.headscaleKeyId);
        await adapter.deleteNode(device.headscaleDeviceId);
        const left = (await adapter.listNodes()).filter(
          (d) => d.headscaleKeyId === minted.headscaleKeyId
        );
        expect(left).toEqual([]);
      } finally {
        await client.stop();
      }
    }, 180_000);

    it("holds zero API keys (HR 12)", async () => {
      expect(await adapter.listApiKeys()).toEqual([]);
    });

    it("an absent socket is a bounded `unavailable`, never a hang", async () => {
      const dead = new HeadscaleSocketAdapter({
        socketPath: path.join(tmpdir(), `hs-absent-${process.pid}.sock`),
        timeoutMs: 1_500,
      });
      const started = Date.now();
      const err = await dead.health().catch((e: unknown) => e);
      dead.close();
      expect(err).toBeInstanceOf(NodeMeshError);
      expect(["unavailable", "timeout"]).toContain((err as NodeMeshError).code);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }
);
