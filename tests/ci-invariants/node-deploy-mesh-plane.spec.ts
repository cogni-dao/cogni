// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-mesh-plane`
 * Purpose: Pin the declarative shape of the per-env mesh plane (task.5428): the Headscale containers,
 *   PVCs, configs and client Service beside the node-deploy sequencer, and the env VM's relay + gateway
 *   Compose services, so a later edit cannot quietly reopen an admin surface, a Tailscale relay or a
 *   shared tailnet.
 * Scope: Reads committed YAML/JSON/shell only; does not run kubectl, docker or touch the network.
 * Invariants:
 *   - ONE_TAILNET_PER_ENV (HR2): own container, PVC `headscale-<env>` (1Gi RWO local-path), socket, port.
 *   - PINNED_AND_BOUNDED: one Headscale digest; requests 25m/64Mi, limits 200m/256Mi; non-root, no caps.
 *   - NO_ADMIN_SURFACE (HR12): gRPC on loopback, insecure refused, sequencer-only unix socket, no API key.
 *   - OUR_RELAY_ONLY (HR9/21): no embedded DERP, no derp.urls, one region = the env VM alias on 443.
 *   - TLS_443_ONLY (HR22): server_url is https://mesh-<env>.<zone> with no port.
 *   - CONFIGS_DIFFER_ONLY_BY_ENV: the three Headscale configs are one file modulo env name and ports.
 *   - RELOADER_NAMED_ONLY (CD5): no reloader `auto`; exactly the projected Secrets.
 *   - SUBSTRATE_GW_HAS_NO_ROUTE_OFF_VM (HR21): it joins only the internal `mesh-gw` network; its two
 *     names resolve to local forwarders; it publishes no port; serve exposes exactly the 5 registry ports.
 * Side-effects: IO (reads committed files)
 * Links: task.5428, task.5384, hub node-service-delivery, infra/k8s/base/node-deploy-mesh/
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;

const ENVS = ["candidate-a", "preview", "production"] as const;
const COMPONENT = "infra/k8s/base/node-deploy-mesh";
const HEADSCALE_IMAGE =
  "ghcr.io/juanfont/headscale:v0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970";
const VM_HOST: Record<(typeof ENVS)[number], string> = {
  "candidate-a": "cogni-candidate-a.vm.cognidao.org",
  preview: "cogni-preview.vm.cognidao.org",
  production: "cogni.vm.cognidao.org",
};
const REGISTRY_PORTS = ["4000", "5432", "5435", "6379", "7233"];

interface Container {
  name: string;
  image?: string;
  args?: string[];
  ports?: { name: string; containerPort: number }[];
  resources?: unknown;
  securityContext?: Record<string, unknown>;
  volumeMounts?: {
    name: string;
    mountPath: string;
    subPath?: string;
    readOnly?: boolean;
  }[];
}
interface PodPatch {
  spec: {
    template: {
      spec: {
        containers: Container[];
        volumes: {
          name: string;
          emptyDir?: unknown;
          configMap?: { name: string };
          persistentVolumeClaim?: { claimName: string };
        }[];
      };
    };
  };
}
interface HeadscaleConfig {
  server_url: string;
  listen_addr: string;
  metrics_listen_addr: string;
  grpc_listen_addr: string;
  grpc_allow_insecure: boolean;
  derp: {
    server: { enabled: boolean };
    urls: string[];
    paths: string[];
    auto_update_enabled: boolean;
  };
  node: { expiry: number; ephemeral: { inactivity_timeout: string } };
  policy: { mode: string };
  unix_socket: string;
  unix_socket_permission: string;
  logtail: { enabled: boolean };
  disable_check_updates: boolean;
}
interface DerpMap {
  regions: Record<
    string,
    {
      regionid: number;
      nodes: {
        hostname: string;
        derpport: number;
        stunport: number;
        stunonly: boolean;
        ipv4?: string;
      }[];
    }
  >;
}
interface ComposeService {
  image?: string;
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  ports?: string[];
  extra_hosts?: string[];
  environment?: Record<string, string>;
  command?: string[];
  user?: string;
  cap_drop?: string[];
  read_only?: boolean;
}

const patch = parse<PodPatch>(`${COMPONENT}/deployment-patch.yaml`);
const podSpec = patch.spec.template.spec;
const config = (env: string) =>
  parse<HeadscaleConfig>(`${COMPONENT}/config/headscale-${env}.yaml`);
const port = (addr: string) => Number(addr.split(":").pop());

describe("mesh coordinators beside the node-deploy sequencer (task.5428)", () => {
  it("is a Component carrying exactly three PVCs, the client Service and all six configs", () => {
    const k = parse<{
      kind: string;
      resources: string[];
      configMapGenerator: { name: string; files: string[] }[];
    }>(`${COMPONENT}/kustomization.yaml`);
    expect(k.kind).toBe("Component");
    expect(k.resources).toEqual(["pvc.yaml", "service.yaml"]);
    expect(k.configMapGenerator[0]?.files.sort()).toEqual(
      ENVS.flatMap((e) => [
        `config/derp-${e}.yaml`,
        `config/headscale-${e}.yaml`,
      ]).sort()
    );
  });

  it("only the production operator overlay (the canonical lanes' sequencer) includes it", () => {
    const prod = parse<{ components?: string[] }>(
      "infra/k8s/overlays/production/operator/kustomization.yaml"
    );
    const cand = parse<{ components?: string[] }>(
      "infra/k8s/overlays/candidate-a/operator/kustomization.yaml"
    );
    expect(prod.components).toContain("../../../base/node-deploy-mesh");
    expect(cand.components ?? []).not.toContain(
      "../../../base/node-deploy-mesh"
    );
  });

  it.each(
    ENVS
  )("headscale-%s: pinned, bounded, unprivileged, own PVC + socket + config", (env) => {
    const c = podSpec.containers.find((x) => x.name === `headscale-${env}`);
    expect(c).toBeDefined();
    expect(c?.image).toBe(HEADSCALE_IMAGE);
    expect(c?.args).toEqual([
      "serve",
      "--config",
      "/etc/headscale/config.yaml",
    ]);
    expect(c?.resources).toEqual({
      requests: { cpu: "25m", memory: "64Mi" },
      limits: { cpu: "200m", memory: "256Mi" },
    });
    expect(c?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
    expect(c?.ports?.[0]?.containerPort).toBe(port(config(env).listen_addr));
    expect(c?.volumeMounts).toEqual([
      { name: `headscale-${env}`, mountPath: "/var/lib/headscale" },
      { name: "headscale-sockets", mountPath: "/var/run/headscale" },
      {
        name: "headscale-config",
        mountPath: "/etc/headscale/config.yaml",
        subPath: `headscale-${env}.yaml`,
        readOnly: true,
      },
      {
        name: "headscale-config",
        mountPath: "/etc/headscale/derp.yaml",
        subPath: `derp-${env}.yaml`,
        readOnly: true,
      },
    ]);
    expect(
      podSpec.volumes.find((v) => v.name === `headscale-${env}`)
        ?.persistentVolumeClaim
    ).toEqual({ claimName: `headscale-${env}` });
  });

  it("the sequencer is the only other container on the socket volume, and it holds no API key", () => {
    const seq = podSpec.containers.find((x) => x.name === "sequencer");
    expect(seq?.volumeMounts).toEqual([
      { name: "headscale-sockets", mountPath: "/var/run/headscale" },
    ]);
    expect(podSpec.containers.map((c) => c.name).sort()).toEqual(
      ["sequencer", ...ENVS.map((e) => `headscale-${e}`)].sort()
    );
    expect(read(`${COMPONENT}/deployment-patch.yaml`)).not.toMatch(
      /HEADSCALE_API_KEY|apikey|api_key/i
    );
  });

  it("PVCs are headscale-<env>, 1Gi, ReadWriteOnce, local-path", () => {
    const pvcs = yaml.parseAllDocuments(read(`${COMPONENT}/pvc.yaml`)).map(
      (d) =>
        d.toJS() as {
          metadata: { name: string };
          spec: Record<string, unknown>;
        }
    );
    expect(pvcs.map((p) => p.metadata.name)).toEqual(
      ENVS.map((e) => `headscale-${e}`)
    );
    for (const p of pvcs) {
      expect(p.spec).toEqual({
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        resources: { requests: { storage: "1Gi" } },
      });
    }
  });

  it.each(
    ENVS
  )("headscale-%s config: TLS 443 control, no admin surface, our relay only", (env) => {
    const c = config(env);
    expect(c.server_url).toBe(`https://mesh-${env}.cognidao.org`);
    expect(c.grpc_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.metrics_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.grpc_allow_insecure).toBe(false);
    expect(c.unix_socket).toBe(`/var/run/headscale/${env}.sock`);
    expect(c.unix_socket_permission).toBe("0770");
    expect(c.derp).toEqual({
      server: { enabled: false },
      urls: [],
      paths: ["/etc/headscale/derp.yaml"],
      auto_update_enabled: false,
    });
    expect(c.node).toEqual({
      expiry: 0,
      ephemeral: { inactivity_timeout: "5m" },
    });
    expect(c.policy.mode).toBe("database");
    expect(c.logtail.enabled).toBe(false);
    expect(c.disable_check_updates).toBe(true);
    expect(port(c.listen_addr)).not.toBe(8080); // the sequencer's health port

    const derp = parse<DerpMap>(`${COMPONENT}/config/derp-${env}.yaml`);
    const regions = Object.values(derp.regions);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.nodes).toEqual([
      expect.objectContaining({
        hostname: VM_HOST[env],
        derpport: 443,
        stunport: 3478,
        stunonly: false,
      }),
    ]);
    expect(regions[0]?.nodes[0]?.ipv4).toBeUndefined();
  });

  it("the three configs differ only by env name and pod-local ports (no shared port)", () => {
    const normalize = (env: string) =>
      read(`${COMPONENT}/config/headscale-${env}.yaml`)
        .replace(
          new RegExp(`(mesh-|headscale/|for the )${env}([. ])`, "g"),
          "$1<env>$2"
        )
        .replace(/:(81|91)8\d$/gm, ":<port>")
        .replace(/:5048\d$/gm, ":<port>");
    expect(normalize("preview")).toBe(normalize("candidate-a"));
    expect(normalize("production")).toBe(normalize("candidate-a"));
    const ports = ENVS.flatMap((e) => [
      port(config(e).listen_addr),
      port(config(e).metrics_listen_addr),
      port(config(e).grpc_listen_addr),
    ]);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("the client Service maps headscale-<env> to each container port, off the node_port stride", () => {
    const svc = parse<{
      spec: {
        type: string;
        ports: {
          name: string;
          port: number;
          targetPort: string;
          nodePort: number;
        }[];
      };
    }>(`${COMPONENT}/service.yaml`);
    expect(svc.spec.type).toBe("NodePort");
    expect(svc.spec.ports.map((p) => p.name)).toEqual(
      ENVS.map((e) => `headscale-${e}`)
    );
    for (const env of ENVS) {
      const p = svc.spec.ports.find((x) => x.name === `headscale-${env}`);
      const c = podSpec.containers.find((x) => x.name === `headscale-${env}`);
      expect(p?.port).toBe(port(config(env).listen_addr));
      expect(p?.targetPort).toBe(c?.ports?.[0]?.name);
      expect((p?.nodePort ?? 0) % 100).not.toBe(0);
    }
  });

  it("Reloader rolls the pod only for the Secrets it reads (CD5)", () => {
    const base = read("infra/k8s/base/node-deploy-sequencer/deployment.yaml");
    const doc = yaml.parse(base) as {
      metadata: { annotations: Record<string, string> };
      spec: {
        template: {
          spec: {
            volumes: {
              projected?: { sources: { secret: { name: string } }[] };
            }[];
          };
        };
      };
    };
    expect(
      doc.metadata.annotations["reloader.stakater.com/auto"]
    ).toBeUndefined();
    const projected = new Set(
      doc.spec.template.spec.volumes.flatMap(
        (v) => v.projected?.sources.map((s) => s.secret.name) ?? []
      )
    );
    expect(
      doc.metadata.annotations["secret.reloader.stakater.com/reload"]
        ?.split(",")
        .sort()
    ).toEqual([...projected].sort());
  });
});

describe("env VM relay + gateway Compose services (task.5428)", () => {
  const compose = parse<{
    services: Record<string, ComposeService>;
    networks: Record<
      string,
      { internal?: boolean; ipam?: { config: { subnet: string }[] } }
    >;
  }>("infra/compose/runtime/docker-compose.yml");
  const svc = (name: string): ComposeService => {
    const s = compose.services[name];
    if (!s) throw new Error(`compose service ${name} missing`);
    return s;
  };
  const ipOn = (name: string, net: string) => {
    const n = svc(name).networks;
    return Array.isArray(n) ? undefined : n?.[net]?.ipv4_address;
  };

  it("the catalog row scopes exactly the mesh services, candidate-a first", () => {
    const row = parse<{
      type: string;
      envs: string[];
      compose_services: string[];
    }>("infra/catalog/derper.yaml");
    expect(row.type).toBe("infra");
    expect(row.envs).toEqual(["candidate-a"]);
    for (const s of row.compose_services)
      expect(compose.services[s]).toBeDefined();
  });

  it("substrate-gw has no route off the VM: internal mesh-gw only, local names, no published port", () => {
    const gw = svc("substrate-gw");
    expect(gw.networks).toEqual({ "mesh-gw": { ipv4_address: "10.100.9.2" } });
    expect(compose.networks["mesh-gw"]?.internal).toBe(true);
    expect(gw.ports).toBeUndefined();
    expect(gw.extra_hosts).toEqual([
      `\${MESH_CONTROL_HOST:-mesh-control.invalid}:${ipOn("mesh-control-fwd", "mesh-gw")}`,
      `\${MESH_VM_HOST:-mesh-vm.invalid}:${ipOn("substrate-fwd", "mesh-gw")}`,
    ]);
    expect(gw.image).toBe(
      "tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c"
    );
    expect(gw.environment).toMatchObject({
      TS_NO_LOGS_NO_SUPPORT: "true",
      MESH_CONTROL_URL: "https://${MESH_CONTROL_HOST:-mesh-control.invalid}",
      SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:
        "${SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:-14400}",
    });
    expect(gw.cap_drop).toEqual(["ALL"]);
    expect(gw.read_only).toBe(true);
  });

  it("serve exposes exactly the five registry ports, each through the local forwarder", () => {
    const serve = JSON.parse(
      read("infra/compose/runtime/configs/mesh/serve.json")
    ) as {
      TCP: Record<string, { TCPForward: string }>;
    };
    expect(Object.keys(serve.TCP).sort()).toEqual(REGISTRY_PORTS);
    for (const [p, v] of Object.entries(serve.TCP)) {
      expect(v.TCPForward).toBe(`substrate-fwd:${p}`);
    }
  });

  it("the watchdog is fail-closed by default (4 h) and holds no key", () => {
    const sh = read("infra/compose/runtime/configs/mesh/substrate-gw.sh");
    expect(sh).toContain(
      'BOUND="${SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:-14400}"'
    );
    expect(sh).toContain("ts serve reset");
    expect(sh).toContain("--advertise-tags=tag:substrate");
    expect(sh).not.toMatch(/--auth-?key|TS_AUTHKEY/);
  });

  it("derper is pinned by digest, unprivileged, our relay checking its env coordinator (fail open)", () => {
    const d = svc("derper");
    expect(d.image).toMatch(
      /^ghcr\.io\/cogni-dao\/cogni-template:derper-[0-9a-f]{12}@sha256:[0-9a-f]{64}$/
    );
    expect(d.ports).toEqual(["3478:3478/udp"]);
    expect(d.command).toEqual(
      expect.arrayContaining([
        "-a=:3340",
        "-http-port=-1",
        "-verify-client-url=https://${MESH_CONTROL_HOST:-mesh-control.invalid}/verify",
        "-verify-client-url-fail-open=true",
      ])
    );
    expect(d.user).toBe("65532:65532");
    expect(d.cap_drop).toEqual(["ALL"]);
  });
});
