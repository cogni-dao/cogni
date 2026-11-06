// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/node-deploy-mesh-plane`
 * Purpose: Pin the declarative shape of the per-env mesh plane (task.5428): the Headscale coordinators
 *   beside the production node-deploy sequencer, and the env VM plane (relay, substrate-gw, forwarders)
 *   on the env VM's own k3s, so a later edit cannot quietly reopen an admin surface, share a socket, a
 *   tailnet or a route to a Tailscale-operated host.
 * Scope: Reads committed files and does not contact a cluster, Docker or the network (renders overlays only if kubectl exists).
 * Invariants:
 *   - ONE_TAILNET_PER_ENV (HR2): own container, PVC `headscale-<env>`, port and socket VOLUME; each socket
 *     volume is mounted only by its Headscale and the sequencer (all containers share uid 1001).
 *   - PINNED_AND_BOUNDED: one Headscale digest; requests 25m/64Mi, limits 200m/256Mi; non-root, no caps.
 *   - NO_ADMIN_SURFACE (HR12): gRPC on loopback, insecure refused, socket 0700, no API key.
 *   - NO_READINESS_COUPLING (CD5/CD7): no Headscale readiness probe; the client Service publishes
 *     not-ready addresses.
 *   - RELOADER_NAMED_ONLY (CD5): no `auto`; exactly the projected Secrets and the operator ConfigMap.
 *   - OUR_RELAY_ONLY / TLS_443_ONLY (HR9/21/22): no embedded DERP, no derp.urls, https server_url.
 *   - ENV_PLANE_ON_ENV_K3S (B5): relay + gateway are an Argo-delivered Component on the env cluster;
 *     no Compose service, no deploy-infra.sh logic.
 *   - SUBSTRATE_GW_EGRESS_IS_POLICY (HR21): NetworkPolicy lets substrate-gw reach only its forwarders,
 *     no DNS; its names pin to the forwarders' static-band ClusterIPs (unique in the repo); the control
 *     name is the SAME Headscale server_url host the DNS writer publishes; forwarder egress allows the
 *     post-DNAT destinations.
 *   - EVICTED_LAST (B17): every env-plane container is Guaranteed and runs at cogni-mesh-critical.
 * Side-effects: IO (reads committed files; optional local kubectl kustomize)
 * Links: task.5428, task.5384, task.5435, hub node-service-delivery, infra/k8s/base/node-deploy-mesh/,
 *   infra/k8s/base/mesh-env-plane/
 * @internal
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;
const parseAll = <T>(relative: string): T[] =>
  yaml.parseAllDocuments(read(relative)).map((d) => d.toJS() as T);

const ENVS = ["candidate-a", "preview", "production"] as const;
const COMPONENT = "infra/k8s/base/node-deploy-mesh";
const ENV_PLANE = "infra/k8s/base/mesh-env-plane";
const CAND_OVERLAY = "infra/k8s/overlays/candidate-a/mesh-plane";
const HEADSCALE_IMAGE =
  "ghcr.io/juanfont/headscale:v0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970";
const VM_HOST: Record<(typeof ENVS)[number], string> = {
  "candidate-a": "cogni-candidate-a.vm.cognidao.org",
  preview: "cogni-preview.vm.cognidao.org",
  production: "cogni.vm.cognidao.org",
};
// The service-type registry ports + scheduler-worker health (30900, reviewed mesh-grantable, T5).
const REGISTRY_PORTS = ["30900", "4000", "5432", "5435", "6379", "7233"];

interface Mount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
}
interface Port {
  name: string;
  containerPort: number;
  hostPort?: number;
  protocol?: string;
}
interface Container {
  name: string;
  image?: string;
  args?: string[];
  command?: string[];
  env?: { name: string; value?: string }[];
  ports?: Port[];
  resources?: { requests?: unknown; limits?: unknown };
  securityContext?: Record<string, unknown>;
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  volumeMounts?: Mount[];
}
interface Volume {
  name: string;
  emptyDir?: Record<string, unknown>;
  configMap?: { name: string };
  persistentVolumeClaim?: { claimName: string };
  projected?: { sources: { secret: { name: string } }[] };
}
interface PodSpec {
  containers: Container[];
  volumes: Volume[];
  priorityClassName?: string;
  hostAliases?: { ip: string; hostnames: string[] }[];
}
interface Workload {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    template: { spec: PodSpec };
    type?: string;
    clusterIP?: string;
    publishNotReadyAddresses?: boolean;
    ports?: {
      name: string;
      port: number;
      targetPort: string;
      nodePort?: number;
    }[];
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

const config = (env: string) =>
  parse<HeadscaleConfig>(`${COMPONENT}/config/headscale-${env}.yaml`);
const port = (addr: string) => Number(addr.split(":").pop());
const hostOf = (url: string) => url.replace(/^https:\/\//, "");

const kubectlAvailable = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const render = (overlay: string): Workload[] =>
  yaml
    .parseAllDocuments(
      execFileSync("kubectl", ["kustomize", path.join(root, overlay)], {
        encoding: "utf8",
      })
    )
    .map((d) => d.toJS() as Workload);

/** Which containers of a pod spec mount each volume. */
function mountersByVolume(spec: PodSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of spec.containers) {
    for (const m of c.volumeMounts ?? []) {
      out[m.name] = [...(out[m.name] ?? []), c.name].sort();
    }
  }
  return out;
}

function expectSocketIsolation(spec: PodSpec) {
  const mounters = mountersByVolume(spec);
  for (const env of ENVS) {
    const vol = `headscale-socket-${env}`;
    expect(mounters[vol], vol).toEqual(
      [`headscale-${env}`, "sequencer"].sort()
    );
    expect(spec.volumes.find((v) => v.name === vol)?.emptyDir).toEqual({
      medium: "Memory",
      sizeLimit: "1Mi",
    });
    for (const c of spec.containers.filter((x) =>
      [`headscale-${env}`, "sequencer"].includes(x.name)
    )) {
      expect(c.volumeMounts?.find((m) => m.name === vol)?.mountPath).toBe(
        `/var/run/headscale/${env}`
      );
    }
  }
  expect(
    spec.volumes.filter((v) => v.name.startsWith("headscale-socket")).length
  ).toBe(ENVS.length);
}

describe("mesh coordinators beside the production node-deploy sequencer (task.5428)", () => {
  const patch = parse<Workload>(`${COMPONENT}/deployment-patch.yaml`);
  const podSpec = patch.spec.template.spec;

  it("is a Component with three PVCs, the client Service and all six configs, in production only", () => {
    const k = parse<{
      kind: string;
      resources: string[];
      configMapGenerator: { files: string[] }[];
    }>(`${COMPONENT}/kustomization.yaml`);
    expect(k.kind).toBe("Component");
    expect(k.resources).toEqual(["pvc.yaml", "service.yaml"]);
    expect(k.configMapGenerator[0]?.files.sort()).toEqual(
      ENVS.flatMap((e) => [
        `config/derp-${e}.yaml`,
        `config/headscale-${e}.yaml`,
      ]).sort()
    );
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
  )("headscale-%s: pinned, bounded, unprivileged, no readiness probe, own PVC + config", (env) => {
    const c = podSpec.containers.find((x) => x.name === `headscale-${env}`);
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
    expect(c?.readinessProbe).toBeUndefined();
    expect(c?.livenessProbe).toBeDefined();
    expect(c?.ports?.[0]?.containerPort).toBe(port(config(env).listen_addr));
    expect(c?.volumeMounts).toEqual([
      { name: `headscale-${env}`, mountPath: "/var/lib/headscale" },
      {
        name: `headscale-socket-${env}`,
        mountPath: `/var/run/headscale/${env}`,
      },
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

  it("each env socket volume is mounted ONLY by that env's Headscale and the sequencer (patch)", () => {
    expectSocketIsolation(podSpec);
    expect(read(`${COMPONENT}/deployment-patch.yaml`)).not.toMatch(
      /HEADSCALE_API_KEY|apikey|api_key/i
    );
  });

  it.skipIf(!kubectlAvailable)(
    "each env socket volume is mounted ONLY by that env's Headscale and the sequencer (rendered production overlay)",
    () => {
      const dep = render("infra/k8s/overlays/production/operator").find(
        (d) =>
          d?.kind === "Deployment" &&
          d.metadata.name === "operator-node-deploy-sequencer"
      );
      expect(dep).toBeDefined();
      if (dep) expectSocketIsolation(dep.spec.template.spec);
    }
  );

  it("PVCs are headscale-<env>, 1Gi, ReadWriteOnce, local-path", () => {
    const pvcs = parseAll<{
      metadata: { name: string };
      spec: Record<string, unknown>;
    }>(`${COMPONENT}/pvc.yaml`);
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
  )("headscale-%s config: TLS 443 control, no admin surface, own socket, our relay only", (env) => {
    const c = config(env);
    expect(c.server_url).toBe(`https://mesh-${env}.cognidao.org`);
    expect(c.grpc_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.metrics_listen_addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(c.grpc_allow_insecure).toBe(false);
    expect(c.unix_socket).toBe(`/var/run/headscale/${env}/headscale.sock`);
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
    expect(port(c.listen_addr)).not.toBe(8080);
    const derp = parse<{
      regions: Record<string, { nodes: Record<string, unknown>[] }>;
    }>(`${COMPONENT}/config/derp-${env}.yaml`);
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
          new RegExp(
            `(mesh-|headscale/|headscale-socket-|for the )${env}([. /\`])`,
            "g"
          ),
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

  it("the client Service maps headscale-<env> to each container, off the node_port stride, not-ready published", () => {
    const svc = parse<Workload>(`${COMPONENT}/service.yaml`);
    expect(svc.spec.type).toBe("NodePort");
    expect(svc.spec.publishNotReadyAddresses).toBe(true);
    expect(svc.spec.ports?.map((p) => p.name)).toEqual(
      ENVS.map((e) => `headscale-${e}`)
    );
    for (const env of ENVS) {
      const p = svc.spec.ports?.find((x) => x.name === `headscale-${env}`);
      const c = podSpec.containers.find((x) => x.name === `headscale-${env}`);
      expect(p?.port).toBe(port(config(env).listen_addr));
      expect(p?.targetPort).toBe(c?.ports?.[0]?.name);
      expect((p?.nodePort ?? 0) % 100).not.toBe(0);
    }
  });

  it("Reloader rolls the pod only for the Secrets and the operator ConfigMap it reads (CD5)", () => {
    const doc = parse<Workload>(
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
    for (const env of ["candidate-a", "production"]) {
      const k = parse<{ namePrefix: string; patches: { patch?: string }[] }>(
        `infra/k8s/overlays/${env}/operator/kustomization.yaml`
      );
      expect(k.namePrefix).toBe("operator-");
      const refs = (
        k.patches
          .map((p) => p.patch ?? "")
          .join("\n")
          .match(/configMapKeyRef:\s*\n\s*name: ([a-z-]+)/g) ?? []
      ).map((m) => m.replace(/.*name: /s, ""));
      expect(new Set(refs)).toEqual(new Set(["node-app-config"]));
    }
  });
});

describe("env VM mesh plane on the env's own k3s (task.5428, B5)", () => {
  const docs = (file: string) => parseAll<Workload>(`${ENV_PLANE}/${file}`);
  const derper = docs("derper.yaml")[0] as Workload;
  const gw = docs("substrate-gw.yaml")[0] as Workload;
  const fwd = docs("forwarders.yaml");
  const overlay = parse<{
    namespace: string;
    components: string[];
    configMapGenerator: { name: string; literals: string[] }[];
  }>(`${CAND_OVERLAY}/kustomization.yaml`);
  const meshEnv = Object.fromEntries(
    (
      overlay.configMapGenerator.find((g) => g.name === "mesh-env")?.literals ??
      []
    ).map((l) => l.split("=", 2) as [string, string])
  );

  it("is delivered by Argo to the candidate-a cluster from the reviewed control-plane ref", () => {
    const app = parse<{
      spec: {
        source: { path: string; targetRevision: string };
        destination: { server: string; namespace: string };
      };
    }>(
      "infra/k8s/argocd/control-plane/candidate-a/candidate-a-mesh-plane-application.yaml"
    );
    expect(app.spec.source.path).toBe(CAND_OVERLAY);
    expect(app.spec.source.targetRevision).toBe(
      "deploy/candidate-a-control-plane"
    );
    expect(app.spec.destination).toEqual({
      server: "https://kubernetes.default.svc",
      namespace: "cogni-mesh",
    });
    expect(overlay.namespace).toBe("cogni-mesh");
    expect(overlay.components).toEqual(["../../../base/mesh-env-plane"]);
    expect(
      parse<{ kind: string }>(`${ENV_PLANE}/kustomization.yaml`).kind
    ).toBe("Component");
  });

  it("is not a Compose service and adds nothing to the frozen deploy brain", () => {
    expect(read("infra/compose/runtime/docker-compose.yml")).not.toMatch(
      /derper|substrate-gw|mesh-control-fwd/
    );
    expect(read("scripts/ci/deploy-infra.sh")).not.toMatch(
      /MESH_|CATALOG_COMPOSE/
    );
    expect(read("infra/catalog/derper.yaml")).not.toMatch(
      /compose_services|^envs:/m
    );
    expect(
      existsSync(path.join(root, "infra/compose/runtime/configs/mesh"))
    ).toBe(false);
  });

  it("env values come from ONE source each: the control name is the Headscale server_url the DNS writer publishes", () => {
    expect(meshEnv.MESH_CONTROL_HOST).toBe(
      hostOf(config("candidate-a").server_url)
    );
    expect(meshEnv.MESH_VM_HOST).toBe(VM_HOST["candidate-a"]);
    expect(meshEnv.SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS).toBe("14400");
    // reconcile-node-dns.sh writes exactly mesh_control_host_for_env (server_url) DNS-only.
    const dns = read("scripts/ci/reconcile-node-dns.sh");
    expect(dns).toContain('host="$(mesh_control_host_for_env "$lane")"');
    expect(dns).toContain(
      'cf_upsert_a_record "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$host" "$VM_IP" false'
    );
    const control = fwd.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "mesh-control-fwd"
    );
    expect(control?.spec.template.spec.containers[0]?.args).toContain(
      "TCP:$(MESH_CONTROL_HOST):443"
    );
  });

  it("substrate-gw egress is policy: only its two forwarders, no DNS at all (HR21, zero contact)", () => {
    const np = docs("networkpolicy.yaml").find(
      (d) => d.metadata.name === "substrate-gw"
    ) as unknown as {
      spec: {
        podSelector: unknown;
        policyTypes: string[];
        egress: {
          to: { podSelector?: { matchLabels: Record<string, string> } }[];
        }[];
      };
    };
    expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec.podSelector).toEqual({
      matchLabels: { "app.kubernetes.io/name": "substrate-gw" },
    });
    expect(
      np.spec.egress.map((e) => e.to[0]?.podSelector?.matchLabels ?? {})
    ).toEqual([
      { "app.kubernetes.io/name": "mesh-control-fwd" },
      { "app.kubernetes.io/name": "substrate-fwd" },
    ]);
    // Every name substrate-gw dials is a hostAlias, so it needs no resolver: serve.json's target
    // host is one of them.
    const aliases = (gw.spec.template.spec.hostAliases ?? []).flatMap(
      (h) => h.hostnames
    );
    expect(aliases).toContain("substrate-fwd");
  });

  it("forwarder ClusterIPs are in the static band, unique in the repo, and the ONE source of the aliases", () => {
    const ips = ["mesh-control-fwd", "substrate-fwd"].map(
      (name) =>
        fwd.find((d) => d.kind === "Service" && d.metadata.name === name)?.spec
          .clusterIP ?? ""
    );
    for (const ip of ips) {
      const m = ip.match(/^10\.43\.0\.(\d+)$/);
      expect(m, ip).not.toBeNull();
      const last = Number(m?.[1]);
      // k8s >= 1.26 reserves only 10.43.0.0-255 of a /16 for static IPs; .1 apiserver, .10 kube-dns.
      expect(last).toBeGreaterThanOrEqual(16);
      expect(last).toBeLessThanOrEqual(254);
    }
    expect(new Set(ips).size).toBe(2);
    // No other committed manifest uses either address.
    const hits = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-F",
        "-e",
        ips[0] ?? "",
        "-e",
        ips[1] ?? "",
        "--",
        "infra",
      ],
      { cwd: root, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(hits).toEqual([`${ENV_PLANE}/forwarders.yaml`]);
    // The base carries a TEST-NET placeholder; the overlay copies each Service's IP (after patches).
    expect(gw.spec.template.spec.hostAliases?.map((h) => h.ip)).toEqual([
      "192.0.2.1",
      "192.0.2.1",
    ]);
    const overlayRepl = (
      parse<{
        replacements: {
          source: { kind: string; name: string; fieldPath: string };
          targets: { fieldPaths: string[] }[];
        }[];
      }>(`${CAND_OVERLAY}/kustomization.yaml`).replacements ?? []
    ).filter((r) => r.source.kind === "Service");
    expect(
      overlayRepl.map((r) => [
        r.source.name,
        r.source.fieldPath,
        r.targets[0]?.fieldPaths[0],
      ])
    ).toEqual([
      [
        "mesh-control-fwd",
        "spec.clusterIP",
        "spec.template.spec.hostAliases.0.ip",
      ],
      [
        "substrate-fwd",
        "spec.clusterIP",
        "spec.template.spec.hostAliases.1.ip",
      ],
    ]);
  });

  it.skipIf(!kubectlAvailable)(
    "the rendered overlay pins substrate-gw's names to the forwarder Services' ClusterIPs",
    () => {
      const docsOut = render(CAND_OVERLAY);
      const ipOf = (name: string) =>
        docsOut.find((d) => d?.kind === "Service" && d.metadata.name === name)
          ?.spec.clusterIP;
      const dep = docsOut.find(
        (d) => d?.kind === "Deployment" && d.metadata.name === "substrate-gw"
      );
      expect(dep?.spec.template.spec.hostAliases).toEqual([
        {
          ip: ipOf("mesh-control-fwd"),
          hostnames: [meshEnv.MESH_CONTROL_HOST],
        },
        {
          ip: ipOf("substrate-fwd"),
          hostnames: [meshEnv.MESH_VM_HOST, "substrate-fwd"],
        },
      ]);
    }
  );

  it("every container is Guaranteed and every pod runs at cogni-mesh-critical (B17)", () => {
    const pc = parse<{ metadata: { name: string }; value: number }>(
      `${ENV_PLANE}/priorityclass.yaml`
    );
    expect(pc.metadata.name).toBe("cogni-mesh-critical");
    // Outranks every app pod (no app PriorityClass exists: apps run at 0), far below system classes.
    expect(pc.value).toBeGreaterThan(0);
    expect(pc.value).toBeLessThan(1_000_000_000);
    const workloads = [
      derper,
      gw,
      ...fwd.filter((d) => d.kind === "Deployment"),
    ];
    expect(workloads.map((w) => w.metadata.name).sort()).toEqual(
      ["derper", "mesh-control-fwd", "substrate-fwd", "substrate-gw"].sort()
    );
    for (const w of workloads) {
      expect(w.spec.template.spec.priorityClassName, w.metadata.name).toBe(
        "cogni-mesh-critical"
      );
      for (const c of w.spec.template.spec.containers) {
        expect(c.resources?.requests, `${w.metadata.name}/${c.name}`).toEqual(
          c.resources?.limits
        );
        expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
        expect(c.securityContext?.readOnlyRootFilesystem).toBe(true);
      }
    }
  });

  it("exposure: hostPort only for public UDP; the TCP edge-only ports are NodePorts hardened off the public NIC", () => {
    const hostPorts = [derper, gw]
      .flatMap((w) => w.spec.template.spec.containers)
      .flatMap((c) => c.ports ?? [])
      .filter((p) => p.hostPort)
      .map((p) => `${p.protocol}/${p.hostPort}`)
      .sort();
    expect(hostPorts).toEqual(["UDP/3478", "UDP/41641"]);
    const nodePortOf = (file: string, name: string) =>
      docs(file).find((d) => d.kind === "Service" && d.metadata.name === name)
        ?.spec.ports?.[0]?.nodePort;
    const relay = nodePortOf("derper.yaml", "derper");
    const publish = nodePortOf("substrate-gw.yaml", "substrate-gw-publisher");
    expect(relay).toBeDefined();
    expect(publish).toBeDefined();
    expect((relay ?? 0) % 100).not.toBe(0);
    expect((publish ?? 0) % 100).not.toBe(0);
    const harden = read("infra/provision/cherry/harden-docker-public-ports.sh");
    expect(harden).toMatch(
      new RegExp(
        `^MESH_EDGE_ONLY_PORTS="${relay},${publish},32441:32443"$`,
        "m"
      )
    );
  });

  it("substrate-gw: stock pinned tailscale, non-root, no key, fail-closed by default, re-enrolls by itself", () => {
    const c = gw.spec.template.spec.containers.find(
      (x) => x.name === "substrate-gw"
    );
    expect(c?.image).toBe(
      "tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c"
    );
    expect(c?.ports).toEqual([
      {
        name: "wireguard",
        containerPort: 41641,
        hostPort: 41641,
        protocol: "UDP",
      },
    ]);
    expect(c?.env).toEqual(
      expect.arrayContaining([
        { name: "TS_NO_LOGS_NO_SUPPORT", value: "true" },
        { name: "MESH_CONTROL_URL", value: "https://$(MESH_CONTROL_HOST)" },
        { name: "KUBERNETES_SERVICE_HOST", value: "" },
      ])
    );
    expect(
      (
        gw.spec.template.spec as unknown as {
          securityContext: { runAsUser: number };
        }
      ).securityContext.runAsUser
    ).toBe(10001);
    const sh = read(`${ENV_PLANE}/substrate-gw.sh`);
    expect(sh).toContain(
      'BOUND="${SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:-14400}"'
    );
    expect(sh).toContain("ts serve reset");
    expect(sh).toContain("--advertise-tags=tag:substrate");
    expect(sh).toContain('request_enrollment "not_joined_no_pending_request"');
    expect(sh).not.toMatch(/--auth-?key|TS_AUTHKEY/);
  });

  it("serve exposes exactly the registry ports + worker health, each through substrate-fwd, policy-allowed", () => {
    const serve = JSON.parse(read(`${ENV_PLANE}/serve.json`)) as {
      TCP: Record<string, { TCPForward: string }>;
    };
    expect(Object.keys(serve.TCP).sort()).toEqual(REGISTRY_PORTS);
    for (const [p, v] of Object.entries(serve.TCP)) {
      expect(v.TCPForward).toBe(`substrate-fwd:${p}`);
    }
    // Every served port has a forwarder listener + Service port and is allowed by both policies.
    const svc = fwd.find(
      (d) => d.kind === "Service" && d.metadata.name === "substrate-fwd"
    );
    const svcPorts = (svc?.spec.ports ?? []).map((p) => String(p.port));
    const policies = docs("networkpolicy.yaml") as unknown as {
      metadata: { name: string };
      spec: { egress: { ports?: { port: number }[] }[] };
    }[];
    const allowed = (name: string) =>
      policies
        .find((np) => np.metadata.name === name)
        ?.spec.egress.flatMap((e) => e.ports ?? [])
        .map((p) => String(p.port)) ?? [];
    const script = fwd
      .find(
        (d) => d.kind === "Deployment" && d.metadata.name === "substrate-fwd"
      )
      ?.spec.template.spec.containers[0]?.args?.join("\n");
    for (const p of REGISTRY_PORTS) {
      expect(svcPorts, `substrate-fwd Service ${p}`).toContain(p);
      expect(allowed("substrate-gw"), `substrate-gw egress ${p}`).toContain(p);
      expect(script).toMatch(new RegExp(`for p in [0-9 ]*\\b${p}\\b`));
    }
  });

  it("substrate-fwd egress allows the TRANSLATED destinations (policy is evaluated after DNAT)", () => {
    interface Peer {
      ipBlock?: { cidr: string };
      namespaceSelector?: { matchLabels: Record<string, string> };
      podSelector?: { matchLabels: Record<string, string> };
    }
    interface Rule {
      to?: Peer[];
      ports?: { protocol: string; port: number }[];
    }
    const np = docs("networkpolicy.yaml").find(
      (d) => d.metadata.name === "substrate-fwd"
    ) as unknown as { spec: { egress: Rule[] } };
    const ports = (r?: Rule) => (r?.ports ?? []).map((p) => p.port).sort();
    const byCidr = np.spec.egress.find((r) => r.to?.[0]?.ipBlock);
    const byWorker = np.spec.egress.find(
      (r) =>
        r.to?.[0]?.podSelector?.matchLabels["app.kubernetes.io/name"] ===
        "scheduler-worker"
    );
    // Docker DNAT: node:5432/5435/6379/4000/7233 -> the Compose `internal` bridge, container ports.
    const compose = parse<{
      services: Record<string, { networks?: string[]; ports?: string[] }>;
      networks: { internal: { ipam: { config: { subnet: string }[] } } };
    }>("infra/compose/runtime/docker-compose.yml");
    expect(byCidr?.to?.[0]?.ipBlock?.cidr).toBe(
      compose.networks.internal.ipam.config[0]?.subnet
    );
    const translated = new Set<number>();
    for (const svcName of [
      "postgres",
      "doltgres",
      "redis",
      "litellm",
      "temporal",
    ]) {
      const svc = compose.services[svcName];
      expect(svc?.networks, svcName).toContain("internal");
      for (const mapping of svc?.ports ?? []) {
        const [published, container] = mapping.split(":").slice(-2);
        if (REGISTRY_PORTS.includes(String(published))) {
          translated.add(Number(container));
        }
      }
    }
    expect(ports(byCidr)).toEqual([...translated].sort());
    // kube-proxy NodePort: node:30900 -> the scheduler-worker pod's container port, in this env.
    const worker = parse<Workload>(
      "infra/k8s/base/scheduler-worker/deployment.yaml"
    );
    expect(ports(byWorker)).toEqual([
      worker.spec.template.spec.containers[0]?.ports?.[0]?.containerPort,
    ]);
    const workerNs = parse<{ namespace: string }>(
      "infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml"
    ).namespace;
    expect(read(`${CAND_OVERLAY}/kustomization.yaml`)).toContain(
      `value: ${workerNs}`
    );
    // The public-NodePort worker port (30900) maps to that pod port, never allowed as-is.
    expect(
      np.spec.egress.flatMap((r) => r.ports ?? []).map((p) => p.port)
    ).not.toContain(30900);
  });

  it.skipIf(!kubectlAvailable)(
    "the rendered overlay scopes the worker-health egress to this env's namespace",
    () => {
      const np = render(CAND_OVERLAY).find(
        (d) =>
          d?.kind === "NetworkPolicy" && d.metadata.name === "substrate-fwd"
      ) as unknown as {
        spec: {
          egress: {
            to?: {
              namespaceSelector?: { matchLabels: Record<string, string> };
            }[];
          }[];
        };
      };
      const namespaces = np.spec.egress
        .flatMap((r) => r.to ?? [])
        .map(
          (p) => p.namespaceSelector?.matchLabels["kubernetes.io/metadata.name"]
        )
        .filter(Boolean);
      expect(namespaces.sort()).toEqual(["cogni-candidate-a", "kube-system"]);
    }
  );

  it("derper is pinned by digest, unprivileged, our relay checking its env coordinator (fail open)", () => {
    const c = derper.spec.template.spec.containers[0];
    expect(c?.image).toMatch(
      /^ghcr\.io\/cogni-dao\/cogni-template:derper-[0-9a-f]{12}@sha256:[0-9a-f]{64}$/
    );
    expect(c?.args).toEqual(
      expect.arrayContaining([
        "-a=:3340",
        "-http-port=-1",
        "-verify-client-url=https://$(MESH_CONTROL_HOST)/verify",
        "-verify-client-url-fail-open=true",
      ])
    );
    expect(c?.securityContext?.capabilities).toEqual({ drop: ["ALL"] });
  });
});
