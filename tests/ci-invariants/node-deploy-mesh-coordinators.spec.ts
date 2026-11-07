// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-mesh-coordinators`
 * Purpose: Pin the per-tailnet mesh coordinators (Headscale) beside the node-deploy sequencer (task.5428 P3) to the one tailnet table in scripts/ci/lib/mesh-plane.sh, so a later edit cannot share a socket or a tailnet, reopen an admin surface, or drift from the edge and DNS writers.
 * Scope: Reads committed files and does not contact a cluster or the network (renders overlays only if kubectl exists).
 * Invariants:
 *   - ONE_TAILNET_ONE_COORDINATOR (HR2): one Component per tailnet; each operator overlay includes exactly the tailnets
 *     its sequencer writes (production: canonical; candidate-a test operator: its own); own container, PVC, port and socket
 *     VOLUME mounted only by that Headscale and the sequencer.
 *   - NO_ADMIN_SURFACE / TLS_443_ONLY / OUR_RELAY_ONLY (HR9/12/21/22): loopback gRPC, 0700 socket, https server_url, no
 *     public DERP, one region = the tailnet's own relay host; table-derived NodePorts with publishNotReadyAddresses.
 *   - DECOUPLED_HEALTH (CD5/CD7): no Headscale readiness probe; Reloader rolls only on the sequencer's Secrets + ConfigMap;
 *     the rollout alert reads Kubernetes events and a liveness rule pages when that source is silent.
 *   - ONE_WRITER_PER_MESH_RECORD (CD4): every mesh record (each tailnet's control host; its relay host once it has a
 *     VM) has exactly one real writer. In the CI writer's zone (production's workload zone): reconcile-node-dns.sh in the
 *     coordinator env's run. In any other zone: the coordinator env's operator sequencer, whose bound workload zone must
 *     equal that zone and whose NODE_DEPLOY_MESH_DNS_RECORDS must list exactly those records, each a CNAME to its VM
 *     alias. No overlay declares a record the table does not derive.
 *   - MESH_LANE_NEEDS_ITS_GATEWAY (CD6): every `<env>=mesh[:<tailnet>]` lane in an operator overlay names a tailnet whose
 *     VM env-plane instance (overlays/<env>/mesh-plane/<tailnet>) and its Argo Application are in the repo, so CI is red
 *     until the gateway the lane needs is on main.
 * Side-effects: IO (reads committed files; optional local kubectl kustomize)
 * Links: task.5428, task.5384, bug.5579, hub node-service-delivery, infra/k8s/base/node-deploy-mesh/
 * @internal
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;

const BASE = "infra/k8s/base/node-deploy-mesh/tailnets";
const HEADSCALE_IMAGE =
  "ghcr.io/juanfont/headscale:v0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970";

interface Tailnet {
  tailnet: string;
  vm_env: string;
  coordinator_env: string;
  control_label: string;
  relay_label: string;
  coordinator_np: string;
  derp_region: string;
  zone: string;
}
const FIELDS = [
  "tailnet",
  "vm_env",
  "coordinator_env",
  "control_label",
  "relay_label",
  "coordinator_np",
  "relay_np",
  "publish_np",
  "wireguard_port",
  "derp_region",
  "zone",
] as const;
const TABLE: Tailnet[] = (
  read("scripts/ci/lib/mesh-plane.sh").match(
    /MESH_TAILNETS_TABLE='\n([\s\S]*?)\n'/
  )?.[1] ?? ""
)
  .trim()
  .split("\n")
  .map(
    (row) =>
      Object.fromEntries(
        row.split("|").map((v, i) => [FIELDS[i], v])
      ) as unknown as Tailnet
  );

interface Mount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
}
interface Container {
  name: string;
  image?: string;
  args?: string[];
  ports?: { name: string; containerPort: number }[];
  resources?: unknown;
  securityContext?: unknown;
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  volumeMounts?: Mount[];
}
interface PodSpec {
  containers: Container[];
  volumes: {
    name: string;
    emptyDir?: unknown;
    configMap?: { name: string };
    persistentVolumeClaim?: { claimName: string };
    projected?: { sources: { secret: { name: string } }[] };
  }[];
}
interface Doc {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    template: { spec: PodSpec };
    type?: string;
    publishNotReadyAddresses?: boolean;
    ports?: {
      name: string;
      port: number;
      targetPort: string;
      nodePort: number;
    }[];
    accessModes?: string[];
    storageClassName?: string;
    resources?: unknown;
  };
}
interface HeadscaleConfig {
  server_url: string;
  listen_addr: string;
  metrics_listen_addr: string;
  grpc_listen_addr: string;
  grpc_allow_insecure: boolean;
  derp: unknown;
  node: unknown;
  policy: { mode: string };
  unix_socket: string;
  unix_socket_permission: string;
  logtail: { enabled: boolean };
  disable_check_updates: boolean;
}

const cfg = (t: string) =>
  parse<HeadscaleConfig>(`${BASE}/${t}/headscale.yaml`);
const port = (addr: string) => Number(addr.split(":").pop());
const overlayComponents = (env: string) =>
  parse<{ components?: string[] }>(
    `infra/k8s/overlays/${env}/operator/kustomization.yaml`
  ).components ?? [];

const kubectlAvailable = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function expectSocketIsolation(spec: PodSpec, tailnets: string[]) {
  const mounters: Record<string, string[]> = {};
  for (const c of spec.containers) {
    for (const m of c.volumeMounts ?? []) {
      mounters[m.name] = [...(mounters[m.name] ?? []), c.name].sort();
    }
  }
  for (const t of tailnets) {
    const vol = `headscale-socket-${t}`;
    expect(mounters[vol], vol).toEqual([`headscale-${t}`, "sequencer"].sort());
    expect(spec.volumes.find((v) => v.name === vol)?.emptyDir).toEqual({
      medium: "Memory",
      sizeLimit: "1Mi",
    });
  }
  expect(
    spec.volumes.filter((v) => v.name.startsWith("headscale-socket-")).length
  ).toBe(tailnets.length);
  expect(
    spec.containers
      .map((c) => c.name)
      .filter((n) => n.startsWith("headscale-"))
      .sort()
  ).toEqual(tailnets.map((t) => `headscale-${t}`).sort());
}

describe("mesh coordinators: one Component per tailnet, pinned to the tailnet table (task.5428 P3)", () => {
  it("the table names the canonical tailnets (production zone) and the test operator's own (test-fleet zone)", () => {
    expect(TABLE.map((t) => [t.tailnet, t.zone])).toEqual([
      ["candidate-a", "cognidao.org"],
      ["preview", "cognidao.org"],
      ["production", "cognidao.org"],
      ["test-candidate-a", "cogni-testing.org"],
    ]);
  });

  it.each([
    ["production", ["candidate-a", "preview", "production"]],
    ["candidate-a", ["test-candidate-a"]],
  ])("the %s operator overlay includes exactly the tailnets its sequencer writes", (env, tailnets) => {
    expect(
      TABLE.filter((t) => t.coordinator_env === env).map((t) => t.tailnet)
    ).toEqual(tailnets);
    expect(overlayComponents(env)).toEqual(
      tailnets.map((t) => `../../../base/node-deploy-mesh/tailnets/${t}`)
    );
  });

  it.each(
    TABLE.map((t) => [t.tailnet, t] as const)
  )("tailnet %s: config, relay map, Service and PVC agree with the table", (name, t) => {
    const k = parse<{
      kind: string;
      resources: string[];
      configMapGenerator: { name: string; files: string[] }[];
    }>(`${BASE}/${name}/kustomization.yaml`);
    expect(k.kind).toBe("Component");
    expect(k.resources).toEqual(["pvc.yaml", "service.yaml"]);
    expect(k.configMapGenerator).toEqual([
      {
        name: `node-deploy-mesh-${name}`,
        files: ["headscale.yaml", "derp.yaml"],
      },
    ]);

    const c = cfg(name);
    expect(c.server_url).toBe(`https://${t.control_label}.${t.zone}`);
    expect(c.grpc_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.metrics_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.grpc_allow_insecure).toBe(false);
    expect(c.unix_socket).toBe(`/var/run/headscale/${name}/headscale.sock`);
    expect(c.unix_socket_permission).toBe("0700");
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

    const derp = parse<{
      regions: Record<
        string,
        { regionid: number; nodes: Record<string, unknown>[] }
      >;
    }>(`${BASE}/${name}/derp.yaml`);
    expect(Object.keys(derp.regions)).toEqual([t.derp_region]);
    expect(derp.regions[t.derp_region]?.nodes).toEqual([
      expect.objectContaining({
        hostname: `${t.relay_label}.${t.zone}`,
        derpport: 443,
        // STUN off (relay-only): -1 disables it in the relay map, so clients never probe UDP.
        stunport: -1,
        stunonly: false,
      }),
    ]);
    expect(derp.regions[t.derp_region]?.nodes[0]?.ipv4).toBeUndefined();

    const svc = parse<Doc>(`${BASE}/${name}/service.yaml`);
    expect(svc.metadata.name).toBe(`node-deploy-mesh-${name}`);
    expect(svc.spec.type).toBe("NodePort");
    expect(svc.spec.publishNotReadyAddresses).toBe(true);
    expect(svc.spec.ports?.[0]?.nodePort).toBe(Number(t.coordinator_np));
    expect(svc.spec.ports?.[0]?.port).toBe(port(c.listen_addr));

    const pvc = parse<Doc>(`${BASE}/${name}/pvc.yaml`);
    expect(pvc.metadata.name).toBe(`headscale-${name}`);
    expect(pvc.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: { requests: { storage: "1Gi" } },
    });
  });

  it.each(
    TABLE.map((t) => t.tailnet)
  )("headscale-%s: pinned, bounded, unprivileged, liveness only, own volumes", (name) => {
    const patch = parse<Doc>(`${BASE}/${name}/deployment-patch.yaml`);
    const spec = patch.spec.template.spec;
    const c = spec.containers.find((x) => x.name === `headscale-${name}`);
    expect(c?.image).toBe(HEADSCALE_IMAGE);
    expect(c?.args).toEqual([
      "serve",
      "--config",
      "/etc/headscale/config.yaml",
    ]);
    expect(c?.resources).toEqual({
      requests: { cpu: "25m", memory: "24Mi" },
      limits: { cpu: "200m", memory: "256Mi" },
    });
    expect(c?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
    expect(c?.readinessProbe).toBeUndefined();
    expect(c?.livenessProbe).toBeDefined();
    expect(c?.ports?.[0]?.containerPort).toBe(port(cfg(name).listen_addr));
    const svc = parse<Doc>(`${BASE}/${name}/service.yaml`);
    expect(svc.spec.ports?.[0]?.targetPort).toBe(c?.ports?.[0]?.name);
    expect(c?.volumeMounts?.map((m) => m.name)).toEqual([
      `headscale-${name}`,
      `headscale-socket-${name}`,
      `headscale-config-${name}`,
      `headscale-config-${name}`,
    ]);
    expect(
      spec.containers.find((x) => x.name === "sequencer")?.volumeMounts
    ).toEqual([
      {
        name: `headscale-socket-${name}`,
        mountPath: `/var/run/headscale/${name}`,
      },
    ]);
    expect(read(`${BASE}/${name}/deployment-patch.yaml`)).not.toMatch(
      /HEADSCALE_API_KEY|apikey|api_key/i
    );
  });

  it("every tailnet's files differ only by tailnet name and pod-local ports; no port is shared", () => {
    const names = TABLE.map((t) => t.tailnet);
    const normalize = (t: string, file: string) => {
      const row = TABLE.find((r) => r.tailnet === t) as Tailnet;
      // Compare the parsed YAML (comments and line wrapping are per-tailnet presentation).
      return JSON.stringify(
        yaml
          .parseAllDocuments(read(`${BASE}/${t}/${file}`))
          .map((d) => d.toJS())
      )
        .replaceAll(t, "<t>")
        .replaceAll(row.zone, "<zone>")
        .replace(/\b(81|91)8\d\b/g, "<port>")
        .replace(/\b5048\d\b/g, "<port>")
        .replace(new RegExp(`\\b${row.coordinator_np}\\b`, "g"), "<np>")
        .replace(new RegExp(`\\b${row.derp_region}`, "g"), "<region>")
        .replace(/"stunport":\d+/g, '"stunport":"<stun>"')
        .replace(/hs-[a-z]+/g, "hs-<x>");
    };
    for (const file of [
      "headscale.yaml",
      "derp.yaml",
      "pvc.yaml",
      "service.yaml",
      "deployment-patch.yaml",
      "kustomization.yaml",
    ]) {
      const first = normalize(names[0] as string, file);
      for (const t of names.slice(1)) {
        expect(normalize(t, file), `${t}/${file}`).toBe(first);
      }
    }
    const ports = names.flatMap((t) => [
      port(cfg(t).listen_addr),
      port(cfg(t).metrics_listen_addr),
      port(cfg(t).grpc_listen_addr),
    ]);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).not.toContain(8080);
  });

  it.skipIf(!kubectlAvailable).each([
    ["production", ["candidate-a", "preview", "production"]],
    ["candidate-a", ["test-candidate-a"]],
  ])(
    "rendered %s overlay: each socket volume is mounted ONLY by its Headscale and the sequencer",
    (env, tailnets) => {
      const dep = yaml
        .parseAllDocuments(
          execFileSync(
            "kubectl",
            [
              "kustomize",
              path.join(root, `infra/k8s/overlays/${env}/operator`),
            ],
            { encoding: "utf8" }
          )
        )
        .map((d) => d.toJS() as Doc)
        .find(
          (d) =>
            d?.kind === "Deployment" &&
            d.metadata.name === "operator-node-deploy-sequencer"
        );
      expect(dep).toBeDefined();
      if (dep) expectSocketIsolation(dep.spec.template.spec, tailnets);
    }
  );

  it("NodePort preflight: no other manifest in the repo claims a coordinator NodePort", () => {
    const yamls = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? yamls(`${dir}/${e.name}`)
          : /\.ya?ml$/.test(e.name)
            ? [`${dir}/${e.name}`]
            : []
      );
    const claims = new Map<string, string[]>();
    for (const f of yamls("infra/k8s"))
      for (const m of read(f).matchAll(/nodePort:\s*"?(\d+)"?/g))
        claims.set(m[1] ?? "", [...(claims.get(m[1] ?? "") ?? []), f]);
    for (const t of TABLE)
      expect(claims.get(t.coordinator_np), t.tailnet).toEqual([
        `${BASE}/${t.tailnet}/service.yaml`,
      ]);
  });

  it("every mesh record has exactly one real writer; the test zone's is its operator sequencer (CD4)", () => {
    const overlay = (env: string) =>
      read(`infra/k8s/overlays/${env}/operator/kustomization.yaml`);
    const zoneOf = (env: string) =>
      overlay(env).match(
        /path: \/data\/NODE_DEPLOY_WORKLOAD_ZONE\n\s+value: "?([a-z0-9.-]+)"?/
      )?.[1];
    const declared = (env: string) =>
      (
        overlay(env).match(
          /name: NODE_DEPLOY_MESH_DNS_RECORDS\n\s+value: (\S+)/
        )?.[1] ?? ""
      )
        .split(",")
        .filter(Boolean)
        .sort();
    // scripts/setup/lib/fork-identity.sh vm_host_for_env, canonical fleet in the production zone.
    const vmHost = (env: string) =>
      env === "production"
        ? "cogni.vm.cognidao.org"
        : `cogni-${env}.vm.cognidao.org`;
    const ciZone = zoneOf("production");
    expect(ciZone).toBe("cognidao.org");
    const expected: Record<string, string[]> = {
      production: [],
      "candidate-a": [],
    };
    for (const t of TABLE) {
      // The coordinator env's sequencer derives the control URL https://mesh-<tailnet>.<zone> from its
      // NODE_DEPLOY_WORKLOAD_ZONE (env-lanes.ts), so that zone must be the tailnet's zone.
      expect(zoneOf(t.coordinator_env), t.tailnet).toBe(t.zone);
      if (t.zone === ciZone) continue; // reconcile-node-dns.sh writes it in the coordinator env's run
      expected[t.coordinator_env]?.push(
        `${t.control_label}=${vmHost(t.coordinator_env)}`
      );
      if (t.vm_env)
        expected[t.coordinator_env]?.push(
          `${t.relay_label}=${vmHost(t.vm_env)}`
        );
    }
    expect(expected["candidate-a"]?.length).toBeGreaterThan(0);
    // A mesh lane may only name a tailnet whose coordinator its own overlay runs (socket must exist).
    for (const env of ["production", "candidate-a"]) {
      const raw =
        overlay(env).match(
          /name: NODE_DEPLOY_SUBSTRATE_TRANSPORTS\n\s+value: "?([^"\n]+)"?/
        )?.[1] ?? "";
      for (const entry of raw
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)) {
        const [laneEnv = "", mode = ""] = entry.split("=");
        const [transport, tailnet = laneEnv] = mode.split(":");
        if (transport !== "mesh") continue;
        expect(
          TABLE.some((t) => t.tailnet === tailnet && t.coordinator_env === env),
          `${env}: ${entry}`
        ).toBe(true);
        // A mesh lane's Akash creates reach the substrate only through that tailnet's substrate-gw on the
        // lane env's VM. Minting does not wait for that gateway, so the lane may not be on main before its
        // VM env-plane instance and the Argo Application that reconciles it (CD6; gate by marker, not prose).
        expect(
          TABLE.find((t) => t.tailnet === tailnet)?.vm_env,
          `${env}: ${entry} needs tailnet ${tailnet} to have its VM env-plane on the ${laneEnv} VM`
        ).toBe(laneEnv);
        const instance = `infra/k8s/overlays/${laneEnv}/mesh-plane/${tailnet}`;
        const application = `infra/k8s/argocd/control-plane/${laneEnv}/${laneEnv}-mesh-plane-${tailnet}-application.yaml`;
        for (const f of [`${instance}/kustomization.yaml`, application])
          expect(
            existsSync(path.join(root, f)),
            `${env}: ${entry} needs its VM env-plane instance on main: ${f}`
          ).toBe(true);
        if (existsSync(path.join(root, application)))
          expect(
            parse<{ spec: { source: { path: string } } }>(application).spec
              .source.path,
            application
          ).toBe(instance);
      }
    }
    for (const env of ["production", "candidate-a"])
      expect(declared(env), env).toEqual((expected[env] ?? []).sort());
  });

  it("Reloader rolls the sequencer pod only for the Secrets and the operator ConfigMap it reads (CD5)", () => {
    const doc = parse<Doc>(
      "infra/k8s/base/node-deploy-sequencer/deployment.yaml"
    );
    const ann = doc.metadata.annotations ?? {};
    expect(ann["reloader.stakater.com/auto"]).toBeUndefined();
    const projected = new Set(
      doc.spec.template.spec.volumes.flatMap(
        (v) => v.projected?.sources.map((s) => s.secret.name) ?? []
      )
    );
    expect(
      ann["secret.reloader.stakater.com/reload"]?.split(",").sort()
    ).toEqual([...projected].sort());
    expect(ann["configmap.reloader.stakater.com/reload"]).toBe(
      "operator-node-app-config"
    );
  });

  it("the rollout alert reads Kubernetes events and a liveness rule pages when that source is silent (N1, bug.5579)", () => {
    const rules =
      parse<{
        groups: {
          rules: {
            uid: string;
            noDataState: string;
            data: { model: { expr?: string } }[];
          }[];
        }[];
      }>("infra/grafana/alerts/mesh-plane.alerts.yaml").groups[0]?.rules ?? [];
    const rule = (uid: string) => rules.find((r) => r.uid === uid);
    expect(rule("mesh-sequencer-rollout-slow")?.data[0]?.model.expr).toContain(
      'source="k8s-events"'
    );
    expect(
      rule("mesh-sequencer-rollout-slow")?.data[0]?.model.expr
    ).not.toContain("node_deploy_sequencer_leader");
    const live = rule("mesh-k8s-events-source-silent");
    expect(live?.data[0]?.model.expr).toContain('source="k8s-events"');
    expect(live?.noDataState).toBe("Alerting");
    // The mesh DNS writer's evidence: a failure warns and missing evidence pages.
    expect(rule("mesh-dns-writer-failed")?.data[0]?.model.expr).toContain(
      'msg="node_deploy_sequencer_mesh_dns"'
    );
    expect(rule("mesh-dns-writer-no-data")?.noDataState).toBe("Alerting");
  });
});
