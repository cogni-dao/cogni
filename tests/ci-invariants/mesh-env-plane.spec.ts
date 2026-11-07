// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/mesh-env-plane`
 * Purpose: Pin the env-VM mesh plane (task.5428 P4): one Argo-delivered instance per tailnet of the candidate-a VM (relay, substrate-gw, forwarders), every value equal to the tailnet table in scripts/ci/lib/mesh-plane.sh, so no instance shares a namespace, address or port and substrate-gw keeps no route to a Tailscale-operated host.
 * Scope: Reads committed files and does not contact a cluster or the network (renders overlays only if kubectl exists).
 * Invariants:
 *   - ONE_INSTANCE_PER_TAILNET: own Application, namespace cogni-mesh-<tailnet>, nameSuffix, ClusterIPs, NodePorts and
 *     hostPorts, all from the table; no two instances share any of them.
 *   - SUBSTRATE_GW_ZERO_CONTACT (HR21): NetworkPolicy lets substrate-gw reach only its two forwarders, no DNS; its names
 *     are hostAliases fed from the Services and mesh-env; forwarder egress allows post-DNAT destinations only.
 *   - EVICTED_LAST + PINNED (B17, CD3): Guaranteed resources, a per-instance PriorityClass, digest-pinned images,
 *     fail-closed watchdog by default, no key.
 * Side-effects: IO (reads committed files; optional local kubectl kustomize)
 * Links: task.5428, task.5384, task.5435, hub node-service-delivery, infra/k8s/base/mesh-env-plane/
 * @internal
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;
const parseAll = <T>(relative: string): T[] =>
  yaml.parseAllDocuments(read(relative)).map((d) => d.toJS() as T);

// The VM alias records live in the production zone (vm_host_for_env).
const VM_ZONE = "cognidao.org";
const BASE = "infra/k8s/base/mesh-env-plane";
const FIELDS = [
  "tailnet",
  "vm_env",
  "coordinator_env",
  "control_label",
  "relay_label",
  "coordinator_np",
  "relay_np",
  "publish_np",
  "stun_port",
  "wireguard_port",
  "derp_region",
  "zone",
] as const;
type Row = Record<(typeof FIELDS)[number], string>;
const TABLE: Row[] = (
  read("scripts/ci/lib/mesh-plane.sh").match(
    /MESH_TAILNETS_TABLE='\n([\s\S]*?)\n'/
  )?.[1] ?? ""
)
  .trim()
  .split("\n")
  .map(
    (r) => Object.fromEntries(r.split("|").map((v, i) => [FIELDS[i], v])) as Row
  );
const INSTANCES = TABLE.filter((r) => r.vm_env !== "");
const REGISTRY_PORTS = ["30900", "4000", "5432", "5435", "6379", "7233"];

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
  env?: { name: string; value?: string }[];
  ports?: Port[];
  resources?: { requests?: unknown; limits?: unknown };
  securityContext?: Record<string, unknown>;
}
interface Doc {
  kind: string;
  metadata: { name: string; namespace?: string };
  data?: Record<string, string>;
  value?: number;
  spec: {
    template: {
      spec: {
        containers: Container[];
        priorityClassName?: string;
        hostAliases?: { ip: string; hostnames: string[] }[];
        securityContext?: { runAsUser?: number };
      };
    };
    clusterIP?: string;
    ports?: { name: string; port: number; nodePort?: number }[];
    podSelector?: unknown;
    policyTypes?: string[];
    ingress?: { ports?: { protocol: string; port: number }[] }[];
    egress?: {
      to?: {
        ipBlock?: { cidr: string };
        namespaceSelector?: { matchLabels: Record<string, string> };
        podSelector?: { matchLabels: Record<string, string> };
      }[];
      ports?: { protocol: string; port: number }[];
    }[];
  };
}

const kubectlAvailable = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const overlayDir = (r: Row) =>
  `infra/k8s/overlays/${r.vm_env}/mesh-plane/${r.tailnet}`;
const renderInstance = (r: Row): Doc[] =>
  yaml
    .parseAllDocuments(
      execFileSync("kubectl", ["kustomize", path.join(root, overlayDir(r))], {
        encoding: "utf8",
      })
    )
    .map((d) => d.toJS() as Doc)
    .filter(Boolean);
const find = (docs: Doc[], kind: string, name: string) =>
  docs.find((d) => d.kind === kind && d.metadata.name === name);

describe("env-VM mesh plane: one instance per tailnet (task.5428 P4)", () => {
  it("the candidate-a VM serves exactly the canonical and the test-operator tailnets", () => {
    expect(INSTANCES.map((r) => `${r.vm_env}/${r.tailnet}`)).toEqual([
      "candidate-a/candidate-a",
      "candidate-a/test-candidate-a",
    ]);
  });

  it.each(
    INSTANCES.map((r) => [r.tailnet, r] as const)
  )("instance %s: its own Argo Application on the env cluster, from the reviewed control-plane ref", (name, r) => {
    const app = parse<{
      metadata: { name: string };
      spec: {
        source: { path: string; targetRevision: string };
        destination: { server: string; namespace: string };
      };
    }>(
      `infra/k8s/argocd/control-plane/${r.vm_env}/${r.vm_env}-mesh-plane-${name}-application.yaml`
    );
    expect(app.metadata.name).toBe(`${r.vm_env}-mesh-plane-${name}`);
    expect(app.spec.source.path).toBe(overlayDir(r));
    expect(app.spec.source.targetRevision).toBe(
      `deploy/${r.vm_env}-control-plane`
    );
    expect(app.spec.destination).toEqual({
      server: "https://kubernetes.default.svc",
      namespace: `cogni-mesh-${name}`,
    });
    const k = parse<{
      namespace: string;
      nameSuffix: string;
      components: string[];
      configMapGenerator: { name: string; literals: string[] }[];
    }>(`${overlayDir(r)}/kustomization.yaml`);
    expect(k.namespace).toBe(`cogni-mesh-${name}`);
    expect(k.nameSuffix).toBe(`-${name}`);
    expect(k.components).toEqual(["../../../../base/mesh-env-plane"]);
    const env = Object.fromEntries(
      (
        k.configMapGenerator.find((g) => g.name === "mesh-env")?.literals ?? []
      ).map((l) => l.split("=", 2) as [string, string])
    );
    expect(env).toEqual({
      MESH_TAILNET: name,
      MESH_CONTROL_HOST: `${r.control_label}.${r.zone}`,
      MESH_RELAY_HOST: `${r.relay_label}.${r.zone}`,
      MESH_VM_HOST: `cogni-${r.vm_env}.vm.${VM_ZONE}`,
      MESH_WIREGUARD_PORT: r.wireguard_port,
      SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS: "14400",
    });
  });

  it
    .skipIf(!kubectlAvailable)
    .each(INSTANCES.map((r) => [r.tailnet, r] as const))(
    "rendered instance %s: every host-level value equals the table; names pin to its forwarders",
    (name, r) => {
      const docs = renderInstance(r);
      const sfx = `-${name}`;
      expect(
        docs
          .filter((d) => d.metadata.namespace)
          .every((d) => d.metadata.namespace === `cogni-mesh-${name}`)
      ).toBe(true);
      const ctl = find(docs, "Service", `mesh-control-fwd${sfx}`)?.spec
        .clusterIP;
      const fwd = find(docs, "Service", `substrate-fwd${sfx}`)?.spec.clusterIP;
      const gw = find(docs, "Deployment", `substrate-gw${sfx}`);
      expect(gw?.spec.template.spec.hostAliases).toEqual([
        { ip: ctl, hostnames: [`${r.control_label}.${r.zone}`] },
        { ip: fwd, hostnames: [`${r.relay_label}.${r.zone}`, "substrate-fwd"] },
      ]);
      expect(
        find(docs, "Service", `derper${sfx}`)?.spec.ports?.[0]?.nodePort
      ).toBe(Number(r.relay_np));
      expect(
        find(docs, "Service", `substrate-gw-publisher${sfx}`)?.spec.ports?.[0]
          ?.nodePort
      ).toBe(Number(r.publish_np));
      // STUN OFF (relay-only makes it unneeded): derper exposes only its plain-HTTP DERP port, no hostPort.
      expect(
        find(docs, "Deployment", `derper${sfx}`)?.spec.template.spec
          .containers[0]?.ports
      ).toEqual([{ name: "derp-http", containerPort: 3340, protocol: "TCP" }]);
      // RELAY-ONLY (task.5384 decision, inbox 0d01550b commit 22): substrate-gw exposes no port, no
      // hostPort, and admits no UDP; every packet goes through this tailnet's own relay.
      expect(gw?.spec.template.spec.containers[0]?.ports ?? []).toEqual([]);
      const np = find(docs, "NetworkPolicy", `substrate-gw${sfx}`);
      expect(np?.spec.ingress).toEqual([
        { ports: [{ protocol: "TCP", port: 8080 }] },
      ]);
      // PriorityClass is per instance (cluster-scoped) and every workload uses its own.
      const pc = docs.find((d) => d.kind === "PriorityClass");
      expect(pc?.metadata.name).toBe(`cogni-mesh-critical${sfx}`);
      for (const d of docs.filter((x) => x.kind === "Deployment")) {
        expect(d.spec.template.spec.priorityClassName).toBe(
          `cogni-mesh-critical${sfx}`
        );
      }
      const workerNs = find(docs, "NetworkPolicy", `substrate-fwd${sfx}`)
        ?.spec.egress?.flatMap((e) => e.to ?? [])
        .map(
          (p) => p.namespaceSelector?.matchLabels["kubernetes.io/metadata.name"]
        )
        .filter(Boolean);
      expect(workerNs).toEqual([`cogni-${r.vm_env}`, "kube-system"]);
    }
  );

  it("no two instances share a ClusterIP, NodePort or hostPort; ClusterIPs are static-band and repo-unique", () => {
    const literal = (r: Row, svc: string) => {
      const k = parse<{
        patches: { target: { kind: string; name: string }; patch: string }[];
      }>(`${overlayDir(r)}/kustomization.yaml`);
      const ops = yaml.parse(
        k.patches.find(
          (p) => p.target.kind === "Service" && p.target.name === svc
        )?.patch ?? "[]"
      ) as { path: string; value: string }[];
      return String(ops.find((o) => o.path === "/spec/clusterIP")?.value ?? "");
    };
    const ips = INSTANCES.flatMap((r) => [
      literal(r, "mesh-control-fwd"),
      literal(r, "substrate-fwd"),
    ]);
    expect(new Set(ips).size).toBe(ips.length);
    for (const ip of ips) {
      const last = Number(ip.match(/^10\.43\.0\.(\d+)$/)?.[1]);
      expect(last, ip).toBeGreaterThanOrEqual(16);
      expect(last, ip).toBeLessThanOrEqual(254);
    }
    for (const ip of ips) {
      const hits = execFileSync(
        "git",
        ["grep", "-l", "-F", "-e", ip, "--", "infra"],
        { cwd: root, encoding: "utf8" }
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      // The base default pair also appears in forwarders.yaml; nothing else may use any of them.
      for (const h of hits) {
        expect(
          [
            `${BASE}/forwarders.yaml`,
            ...INSTANCES.map((r) => `${overlayDir(r)}/kustomization.yaml`),
          ],
          `${ip} in ${h}`
        ).toContain(h);
      }
    }
    for (const col of ["relay_np", "publish_np"] as const) {
      const vals = INSTANCES.map((r) => r[col]);
      expect(new Set(vals).size, col).toBe(vals.length);
    }
  });

  it("NodePort preflight: every mesh NodePort is distinct and claimed by no other manifest in the repo", () => {
    const owners: [string, string[]][] = TABLE.flatMap((r) => [
      [
        r.coordinator_np,
        [`infra/k8s/base/node-deploy-mesh/tailnets/${r.tailnet}/service.yaml`],
      ],
      ...(r.vm_env
        ? ([
            [
              r.relay_np,
              [`${BASE}/derper.yaml`, `${overlayDir(r)}/kustomization.yaml`],
            ],
            [
              r.publish_np,
              [
                `${BASE}/substrate-gw.yaml`,
                `${overlayDir(r)}/kustomization.yaml`,
              ],
            ],
          ] as [string, string[]][])
        : []),
    ]);
    const ports = owners.map(([p]) => p);
    expect(new Set(ports).size).toBe(ports.length);
    for (const [port, allowed] of owners) {
      const hits = execFileSync(
        "git",
        ["grep", "-l", "-w", "-e", port, "--", "infra/k8s"],
        { cwd: root, encoding: "utf8" }
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(hits.length, port).toBeGreaterThan(0);
      for (const h of hits) expect(allowed, `${port} in ${h}`).toContain(h);
    }
  });

  it("substrate-gw egress is policy: only its two forwarders, no DNS (HR21, zero contact)", () => {
    const np = parseAll<Doc>(`${BASE}/networkpolicy.yaml`).find(
      (d) => d.metadata.name === "substrate-gw"
    );
    expect(np?.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(
      np?.spec.egress?.map((e) => e.to?.[0]?.podSelector?.matchLabels)
    ).toEqual([
      { "app.kubernetes.io/name": "mesh-control-fwd" },
      { "app.kubernetes.io/name": "substrate-fwd" },
    ]);
    const allowed = np?.spec.egress
      ?.flatMap((e) => e.ports ?? [])
      .map((p) => String(p.port));
    for (const p of REGISTRY_PORTS) expect(allowed).toContain(p);
  });

  it("substrate-fwd egress allows the TRANSLATED destinations (policy is evaluated after DNAT)", () => {
    const np = parseAll<Doc>(`${BASE}/networkpolicy.yaml`).find(
      (d) => d.metadata.name === "substrate-fwd"
    );
    const byCidr = np?.spec.egress?.find((e) => e.to?.[0]?.ipBlock);
    const compose = parse<{
      services: Record<string, { networks?: string[]; ports?: string[] }>;
      networks: { internal: { ipam: { config: { subnet: string }[] } } };
    }>("infra/compose/runtime/docker-compose.yml");
    expect(byCidr?.to?.[0]?.ipBlock?.cidr).toBe(
      compose.networks.internal.ipam.config[0]?.subnet
    );
    const translated = new Set<number>();
    for (const s of ["postgres", "doltgres", "redis", "litellm", "temporal"]) {
      expect(compose.services[s]?.networks, s).toContain("internal");
      for (const m of compose.services[s]?.ports ?? []) {
        const [pub, ctr] = m.split(":").slice(-2);
        if (REGISTRY_PORTS.includes(String(pub))) translated.add(Number(ctr));
      }
    }
    expect((byCidr?.ports ?? []).map((p) => p.port).sort()).toEqual(
      [...translated].sort()
    );
    const worker = parse<Doc>(
      "infra/k8s/base/scheduler-worker/deployment.yaml"
    );
    const byWorker = np?.spec.egress?.find(
      (e) =>
        e.to?.[0]?.podSelector?.matchLabels["app.kubernetes.io/name"] ===
        "scheduler-worker"
    );
    expect(byWorker?.ports?.map((p) => p.port)).toEqual([
      worker.spec.template.spec.containers[0]?.ports?.[0]?.containerPort,
    ]);
    expect(
      np?.spec.egress?.flatMap((e) => e.ports ?? []).map((p) => p.port)
    ).not.toContain(30900);
  });

  it("serve exposes exactly the registry ports + worker health, each through substrate-fwd", () => {
    const serve = JSON.parse(read(`${BASE}/serve.json`)) as {
      TCP: Record<string, { TCPForward: string }>;
    };
    expect(Object.keys(serve.TCP).sort()).toEqual(REGISTRY_PORTS);
    for (const [p, v] of Object.entries(serve.TCP)) {
      expect(v.TCPForward).toBe(`substrate-fwd:${p}`);
    }
    const fwd = parseAll<Doc>(`${BASE}/forwarders.yaml`);
    const svcPorts = (
      fwd.find(
        (d) => d.kind === "Service" && d.metadata.name === "substrate-fwd"
      )?.spec.ports ?? []
    ).map((p) => String(p.port));
    const script = fwd
      .find(
        (d) => d.kind === "Deployment" && d.metadata.name === "substrate-fwd"
      )
      ?.spec.template.spec.containers[0]?.args?.join("\n");
    for (const p of REGISTRY_PORTS) {
      expect(svcPorts).toContain(p);
      expect(script).toMatch(new RegExp(`for p in [0-9 ]*\\b${p}\\b`));
    }
    expect(script).toContain('"TCP:${MESH_RELAY_HOST}:443"');
  });

  it("every container is Guaranteed, hardened and digest-pinned; no hostPort (relay-only, STUN off)", () => {
    const workloads = ["derper.yaml", "substrate-gw.yaml", "forwarders.yaml"]
      .flatMap((f) => parseAll<Doc>(`${BASE}/${f}`))
      .filter((d) => d.kind === "Deployment");
    expect(workloads.map((w) => w.metadata.name).sort()).toEqual(
      ["derper", "mesh-control-fwd", "substrate-fwd", "substrate-gw"].sort()
    );
    for (const w of workloads) {
      expect(w.spec.template.spec.priorityClassName).toBe(
        "cogni-mesh-critical"
      );
      for (const c of w.spec.template.spec.containers) {
        expect(c.resources?.requests, `${w.metadata.name}/${c.name}`).toEqual(
          c.resources?.limits
        );
        expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
        expect(c.securityContext?.readOnlyRootFilesystem).toBe(true);
        expect(c.image).toMatch(/@sha256:[0-9a-f]{64}$/);
        for (const p of c.ports ?? []) {
          expect(p.hostPort, `${c.name}/${p.name}`).toBeUndefined();
        }
      }
    }
    // Right-sized to measured footprints (task.5428): one instance requests at most 108Mi. The candidate-a
    // VM's budget counts every mesh request on it: its env-plane instances AND the test operator's Headscale
    // (P3, coordinator_env candidate-a). The total stays at or under 240Mi, a 31 MiB margin below the VM's
    // 7-day minimum MemAvailable (271 MiB).
    const mib = (v: unknown): number => {
      const m = /^(\d+)Mi$/.exec(String(v));
      if (!m) throw new Error(`memory request not in Mi: ${String(v)}`);
      return Number(m[1]);
    };
    const perInstance = workloads
      .flatMap((w) => w.spec.template.spec.containers)
      .reduce(
        (sum, c) =>
          sum +
          mib(
            (c.resources?.requests as { memory?: string } | undefined)?.memory
          ),
        0
      );
    expect(perInstance).toBeLessThanOrEqual(108);
    const perVm = INSTANCES.filter((r) => r.vm_env === "candidate-a").length;
    const headscale = TABLE.filter(
      (r) => r.coordinator_env === "candidate-a"
    ).map((r) => {
      const patch = parse<Doc>(
        `infra/k8s/base/node-deploy-mesh/tailnets/${r.tailnet}/deployment-patch.yaml`
      );
      const c = patch.spec.template.spec.containers.find(
        (x) => x.name === `headscale-${r.tailnet}`
      );
      return mib(
        (c?.resources?.requests as { memory?: string } | undefined)?.memory
      );
    });
    expect(headscale.length).toBeGreaterThan(0);
    const total = perInstance * perVm + headscale.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(240);
    const pc = parse<Doc>(`${BASE}/priorityclass.yaml`);
    expect(pc.value).toBeGreaterThan(0);
    expect(pc.value).toBeLessThan(1_000_000_000);
  });

  it("derper relays for its own tailnet only and checks its own coordinator (fail open)", () => {
    const c = parseAll<Doc>(`${BASE}/derper.yaml`).find(
      (d) => d.kind === "Deployment"
    )?.spec.template.spec.containers[0];
    expect(c?.image).toMatch(
      /^ghcr\.io\/cogni-dao\/cogni-template:derper-[0-9a-f]{12}@sha256:[0-9a-f]{64}$/
    );
    expect(c?.args).toEqual(
      expect.arrayContaining([
        "-hostname=$(MESH_RELAY_HOST)",
        "-stun=false",
        "-a=:3340",
        "-http-port=-1",
        "-verify-client-url=https://$(MESH_CONTROL_HOST)/verify",
        "-verify-client-url-fail-open=true",
      ])
    );
    expect(c?.args?.some((a) => a.startsWith("-stun-port"))).toBe(false);
    expect(c?.env?.map((e) => e.name)).not.toContain("MESH_STUN_PORT");
  });

  it("substrate-gw: stock pinned tailscale, non-root, no key, fail-closed by default, re-enrolls by itself", () => {
    const gw = parseAll<Doc>(`${BASE}/substrate-gw.yaml`).find(
      (d) => d.kind === "Deployment"
    );
    const c = gw?.spec.template.spec.containers.find(
      (x) => x.name === "substrate-gw"
    );
    expect(c?.image).toBe(
      "tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c"
    );
    expect(c?.env).toEqual(
      expect.arrayContaining([
        { name: "TS_NO_LOGS_NO_SUPPORT", value: "true" },
        { name: "MESH_CONTROL_URL", value: "https://$(MESH_CONTROL_HOST)" },
        { name: "KUBERNETES_SERVICE_HOST", value: "" },
      ])
    );
    expect(gw?.spec.template.spec.securityContext?.runAsUser).toBe(10001);
    const sh = read(`${BASE}/substrate-gw.sh`);
    expect(sh).toContain(
      'BOUND="${SUBSTRATE_GW_MAP_POLL_BOUND_SECONDS:-14400}"'
    );
    expect(sh).toContain("ts serve reset");
    expect(sh).toContain("--advertise-tags=tag:substrate");
    expect(sh).toContain('request_enrollment "not_joined_no_pending_request"');
    expect(sh).not.toMatch(/--auth-?key|TS_AUTHKEY/);
  });

  it("substrate-gw state dir is a subdirectory it owns, never the root-owned volume root (P4 NoState)", () => {
    const gw = parseAll<Doc>(`${BASE}/substrate-gw.yaml`).find(
      (d) => d.kind === "Deployment"
    );
    const c = gw?.spec.template.spec.containers.find(
      (x) => x.name === "substrate-gw"
    ) as
      | (Container & { volumeMounts?: { name: string; mountPath: string }[] })
      | undefined;
    const mount = c?.volumeMounts?.find((m) => m.name === "state")?.mountPath;
    const dir = c?.env?.find((e) => e.name === "TS_STATE_DIR")?.value;
    expect(mount).toBeTruthy();
    // tailscaled chmods its state dir; uid 10001 with no capability cannot chmod the root-owned root.
    expect(dir?.startsWith(`${mount}/`), `${dir} under ${mount}`).toBe(true);
    const sh = read(`${BASE}/substrate-gw.sh`);
    expect(sh).toContain(
      'mkdir -p "$TS_STATE_DIR" && chmod 0700 "$TS_STATE_DIR"'
    );
    expect(sh).toContain('--statedir="$TS_STATE_DIR"');
    expect(sh).toContain('LOST_FILE="${TS_STATE_DIR}/watchdog.lost-since"');
    expect(sh).toContain('STATE_FILE="${TS_STATE_DIR}/tailscaled.state"');
  });

  it("substrate-gw loop re-requests enrollment with backoff while BackendState is NoState", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "substrate-gw-"));
    try {
      const bin = path.join(tmp, "bin");
      mkdirSync(bin);
      const upLog = path.join(tmp, "up.log");
      writeFileSync(
        path.join(bin, "tailscale"),
        [
          "#!/bin/sh",
          'for a in "$@"; do case "$a" in',
          `  serve) echo '{}'; exit 0 ;;`,
          `  up) echo up >> "$UP_LOG"; exit 0 ;;`,
          `  status) printf '{\\n  "BackendState": "NoState",\\n  "AuthURL": "",\\n  "Self": {\\n    "Online": false\\n  }\\n}\\n'; exit 0 ;;`,
          "esac; done",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      writeFileSync(
        path.join(bin, "tailscaled"),
        "#!/bin/sh\nexec sleep 30\n",
        { mode: 0o755 }
      );
      const serve = path.join(tmp, "serve.json");
      writeFileSync(serve, "{}\n");
      mkdirSync(path.join(tmp, "publish"));
      const stateDir = path.join(tmp, "volume", "state");
      const run = spawnSync("sh", [path.join(root, BASE, "substrate-gw.sh")], {
        encoding: "utf8",
        timeout: 6000,
        killSignal: "SIGTERM",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          UP_LOG: upLog,
          MESH_CONTROL_URL: "https://mesh-test.example",
          TS_SERVE_CONFIG: serve,
          TS_STATE_DIR: stateDir,
          TS_SOCKET: path.join(tmp, "ts.sock"),
          SUBSTRATE_GW_PUBLISH_DIR: path.join(tmp, "publish"),
          SUBSTRATE_GW_WATCHDOG_INTERVAL_SECONDS: "1",
        },
      });
      const ups = readFileSync(upLog, "utf8").trim().split("\n").length;
      // boot + at least one NoState re-request (old loop: boot only, then waited forever).
      expect(ups, run.stdout).toBeGreaterThanOrEqual(2);
      expect(run.stdout).toMatch(
        /"msg":"substrate_gw_enrollment_requested".*"backendState":"NoState","backoffSeconds":\d+/
      );
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it("substrate-gw re-request kills and reaps the blocked `tailscale up`: one at a time (B3)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "substrate-gw-up-"));
    const pidsFile = path.join(tmp, "up.pids");
    try {
      const bin = path.join(tmp, "bin");
      mkdirSync(bin);
      // A blocking fake `up` (Headscale unreachable). Each start records how many earlier `up`
      // processes are still alive, then becomes `sleep` under the same pid.
      writeFileSync(
        path.join(bin, "tailscale"),
        [
          "#!/bin/sh",
          'for a in "$@"; do case "$a" in',
          `  serve) echo '{}'; exit 0 ;;`,
          "  up)",
          "    alive=0",
          '    if [ -f "$UP_PIDS" ]; then for p in $(cat "$UP_PIDS"); do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done; fi',
          '    echo "$alive" >> "$UP_ALIVE"',
          '    echo "$$" >> "$UP_PIDS"',
          "    exec sleep 30 ;;",
          `  status) printf '{\\n  "BackendState": "NoState",\\n  "AuthURL": "",\\n  "Self": {\\n    "Online": false\\n  }\\n}\\n'; exit 0 ;;`,
          "esac; done",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      writeFileSync(
        path.join(bin, "tailscaled"),
        "#!/bin/sh\nexec sleep 30\n",
        { mode: 0o755 }
      );
      const serve = path.join(tmp, "serve.json");
      writeFileSync(serve, "{}\n");
      mkdirSync(path.join(tmp, "publish"));
      const aliveFile = path.join(tmp, "up.alive");
      const run = spawnSync("sh", [path.join(root, BASE, "substrate-gw.sh")], {
        encoding: "utf8",
        timeout: 9000,
        killSignal: "SIGTERM",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          UP_PIDS: pidsFile,
          UP_ALIVE: aliveFile,
          MESH_CONTROL_URL: "https://mesh-test.example",
          TS_SERVE_CONFIG: serve,
          TS_STATE_DIR: path.join(tmp, "volume", "state"),
          TS_SOCKET: path.join(tmp, "ts.sock"),
          SUBSTRATE_GW_PUBLISH_DIR: path.join(tmp, "publish"),
          SUBSTRATE_GW_WATCHDOG_INTERVAL_SECONDS: "1",
        },
      });
      const alive = readFileSync(aliveFile, "utf8").trim().split("\n");
      // boot + at least two re-requests; at each start no earlier `up` is still running.
      expect(alive.length, run.stdout).toBeGreaterThanOrEqual(3);
      expect(alive).toEqual(alive.map(() => "0"));
    } finally {
      // Stop only the fake `up` processes this test started.
      try {
        for (const p of readFileSync(pidsFile, "utf8").trim().split("\n")) {
          try {
            process.kill(Number(p), "SIGKILL");
          } catch {
            // already gone
          }
        }
      } catch {
        // no pid file
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("is not a Compose service and adds nothing to the frozen deploy brain", () => {
    expect(read("infra/compose/runtime/docker-compose.yml")).not.toMatch(
      /derper|substrate-gw|mesh-control-fwd/
    );
    expect(read("scripts/ci/deploy-infra.sh")).not.toMatch(/MESH_|mesh-plane/);
  });
});
