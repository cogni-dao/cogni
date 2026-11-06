// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-attempt`
 * Purpose: The pure rules the sequencer applies to ONE attempt on the env tailnet (task.5431, hub
 *   node-service-delivery sections 3, 4 and 6): which transport the attempt uses (HR 18), which substrate
 *   ports its env points at (HR 3), the two operator-owned companions that carry those ports (CD1, CD3,
 *   HR 16, HR 21), and the device-health window that decides a roll (HR 8) and the clone alert.
 * Scope: Pure functions and constants. Does not perform IO, read a clock or log.
 * Invariants:
 *   - TRANSPORT_PER_ATTEMPT (HR 18): an attempt uses the mesh only when its lane is mesh and (a blue is
 *     retained for the workload, or the node served on the mesh before in this lane, or nothing of the
 *     workload serves and the attempt belongs to a new release). Otherwise egress: the node's last served
 *     transport is egress whenever it never served on the mesh, so a lane switch never leaves a node
 *     without a serving path. A stop-then-start or a lost-lease redeploy of a never-meshed node stays
 *     egress.
 *   - LISTENERS_ARE_THE_GRANT (HR 3): the companion listeners and the policy grant are the SAME port set:
 *     the registry ports (`substrate-ports.ts`) that the attempt's resolved env names on a substrate host.
 *     A port outside the registry is never a listener and never granted.
 *   - OPERATOR_OWNED_COMPANIONS (CD1): `cogni-mesh` (Tailscale userspace) and `cogni-substrate` (socat)
 *     are added by the sequencer, never declared by a node; a node service with either name is refused.
 *   - PINNED_ONCE_PER_RELEASE (CD3): the companion digests come from the release's first mesh attempt, so
 *     every attempt of one release runs the same two images.
 *   - UNPRIVILEGED (HR 16): each companion drops to uid 10001 before its process starts; no TUN, no
 *     capability, no host network. `TS_NO_LOGS_NO_SUPPORT=true` and our control URL only (HR 21).
 *   - NO_ADVERTISE_TAGS: a pre-auth-key join never passes `--advertise-tags` (Headscale v0.29.7 refuses
 *     it); the key carries the node tag.
 *   - CONSECUTIVE_SUCCESSFUL_READS (HR 8): device absence counts only across consecutive successful
 *     reads; a failed read, an offline `substrate-gw`, or a `substrate-gw` newer than the count's start
 *     resets it, so a coordinator outage or wipe rolls nothing.
 * Side-effects: none
 * Links: sequencer.ts, mesh-plane.ts, substrate-ports.ts, spec.ts
 * @public
 */

import type {
  AttemptPhase,
  AttemptRow,
  MeshDevice,
  PayerSpec,
  SubstrateTransport,
} from "@/ports";

import { SUBSTRATE_TAG } from "./mesh-policy";
import { SUBSTRATE_PORT_SET } from "./substrate-ports";

/** The host a mesh attempt's app reaches its substrate on: the `cogni-substrate` companion. */
export const MESH_SUBSTRATE_HOST = "cogni-substrate";
/** The Tailscale companion's service name. Its SOCKS5 port is lease-internal. */
export const MESH_COMPANION = "cogni-mesh";
export const MESH_SOCKS_PORT = 1055;
/** The operator-owned companion names a node may never declare. */
export const MESH_COMPANION_NAMES: ReadonlySet<string> = new Set([
  MESH_COMPANION,
  MESH_SUBSTRATE_HOST,
]);
/**
 * `substrate-gw`'s MagicDNS name: its hostname (`substrate-gw.sh` `TS_HOSTNAME`) under the env
 * Headscale's `dns.base_domain` (`mesh.cogni`, infra/k8s/base/node-deploy-mesh/config).
 */
export const MESH_SUBSTRATE_TARGET = "substrate-gw.mesh.cogni";
/** The non-root uid both companions run as (HR 16). */
export const MESH_COMPANION_UID = 10001;

/**
 * The two upstream images that passed phase 2 (task.5384), pinned by digest. A new digest ships with a new
 * operator build and reaches a node only with its next release (PINNED_ONCE_PER_RELEASE).
 */
export const MESH_COMPANION_IMAGES = {
  /** tailscale/tailscale 1.104.4 */
  mesh: "tailscale/tailscale@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c",
  /** alpine/socat 1.8.1.3 */
  substrate:
    "alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed",
} as const;

/** HR 8: a live attempt with no online device for this long, over consecutive successful reads, rolls. */
export const DEVICE_ABSENT_ROLL_MS = 10 * 60_000;
/** HR 8: at most this many device-driven rolls are in flight per env. */
export const MAX_DEVICE_ROLLS_PER_ENV = 2;
/** A device-driven roll counts as in flight until its workload serves again, or for at most this long. */
export const DEVICE_ROLL_INFLIGHT_MS = 60 * 60_000;
/** More than one online device on one attempt key for longer than this logs `node_mesh_device_clone`. */
export const DEVICE_CLONE_ALERT_MS = 2 * 60_000;
/** The `lost` error of a device-driven roll; the in-flight cap counts it. */
export const MESH_DEVICE_ABSENT = "mesh_device_absent";

/** Phases in which an attempt may still serve or become serving: its key stays usable. */
export const MESH_LIVE_PHASES: readonly AttemptPhase[] = [
  "planned",
  "created",
  "proving",
  "proven",
  "active",
  "retiring",
];
/** Phases after which an attempt's key is revoked (close, failure, lost lease, retired blue). */
export const MESH_TERMINAL_PHASES: readonly AttemptPhase[] = [
  "closing",
  "failed",
  "retired",
  "lost",
];
const SERVED_PHASES: readonly AttemptPhase[] = [
  "active",
  "retiring",
  "retired",
  "lost",
];
const SERVING_PHASES: readonly AttemptPhase[] = ["active", "retiring"];

/**
 * HR 18. `workloadAttempts` = every attempt of this workload BEFORE this create (any stop-then-start has
 * not yet changed a phase); `nodeAttempts` = every attempt of the node in this env, all workloads.
 */
export function attemptTransport(input: {
  readonly lane: SubstrateTransport;
  /** True when the create keeps a serving blue of this workload behind it. */
  readonly blueRetained: boolean;
  readonly releaseId: string;
  readonly workloadAttempts: readonly AttemptRow[];
  readonly nodeAttempts: readonly AttemptRow[];
}): SubstrateTransport {
  if (input.lane !== "mesh") return "egress";
  if (input.blueRetained) return "mesh";
  const servedOnMesh = input.nodeAttempts.some(
    (a) => a.transport === "mesh" && SERVED_PHASES.includes(a.phase)
  );
  if (servedOnMesh) return "mesh";
  const serving = input.workloadAttempts.some((a) =>
    SERVING_PHASES.includes(a.phase)
  );
  const redeploy = input.workloadAttempts.some(
    (a) => a.releaseId === input.releaseId && SERVED_PHASES.includes(a.phase)
  );
  // The node never served on the mesh, so its last served transport is egress.
  return !serving && !redeploy ? "mesh" : "egress";
}

const HOST_PORT =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([A-Za-z0-9.-]+):(\d{1,5})(?:[/?#].*)?$/u;

/**
 * HR 3: the registry ports the resolved env names on one of `hosts` (`host:port` or a URL with that
 * host and port). Sorted, deduplicated. A non-registry port on a substrate host is returned in `refused`.
 */
export function substratePortsOf(
  env: Readonly<Record<string, string>>,
  hosts: readonly (string | undefined)[]
): { readonly ports: number[]; readonly refused: string[] } {
  const wanted = new Set(
    hosts.filter((h): h is string => !!h).map((h) => h.toLowerCase())
  );
  const ports = new Set<number>();
  const refused: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = HOST_PORT.exec(value.trim());
    if (!m?.[1] || !m[2] || !wanted.has(m[1].toLowerCase())) continue;
    const port = Number(m[2]);
    if (SUBSTRATE_PORT_SET.has(port)) ports.add(port);
    else refused.push(name);
  }
  return { ports: [...ports].sort((a, b) => a - b), refused };
}

/** `<slug>-<workload>-<release id prefix>-a<attempt>`, a DNS label (Tailscale hostname). */
export function meshDeviceName(input: {
  readonly slug: string;
  readonly workload: string;
  readonly releaseId: string;
  readonly attempt: number;
}): string {
  const tail = `-${input.releaseId.replace(/-/g, "").slice(0, 8)}-a${input.attempt}`;
  const head = `${input.slug}-${input.workload}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63 - tail.length)
    .replace(/-+$/u, "");
  return `${head}${tail}`;
}

/** Run `inner` as uid 10001 with no capability (busybox `adduser` + `su`, as proven on real leases). */
const asCompanionUser = (inner: string): string =>
  [
    "set -eu",
    `adduser -D -H -u ${MESH_COMPANION_UID} cogni 2>/dev/null || true`,
    `exec su -p -s /bin/sh cogni -c '${inner}'`,
  ].join("\n");

export type MeshCompanionService = PayerSpec["services"][number];

/**
 * The two operator-owned companions of one mesh attempt (CD1). `cogni-mesh` joins the env tailnet with
 * the attempt key and serves SOCKS5 inside the lease; `cogni-substrate` listens on exactly `ports` and
 * forwards each through that SOCKS5 port to `substrate-gw`. Neither is exposed outside the lease.
 */
export function meshCompanionServices(input: {
  readonly authKey: string;
  readonly controlUrl: string;
  readonly deviceName: string;
  readonly ports: readonly number[];
  readonly images: { readonly mesh: string; readonly substrate: string };
}): MeshCompanionService[] {
  if (input.ports.length === 0)
    throw new Error("mesh attempt has no substrate port to forward");
  for (const port of input.ports)
    if (!SUBSTRATE_PORT_SET.has(port))
      throw new Error(`port ${port} is not a substrate port`);
  if (!/^https:\/\/[a-z0-9.-]+$/u.test(input.controlUrl))
    throw new Error("mesh control URL must be https://<host> on 443");
  const forwards = input.ports
    .map(
      (p) =>
        `socat -d TCP-LISTEN:${p},fork,reuseaddr SOCKS5-CONNECT:${MESH_COMPANION}:${MESH_SOCKS_PORT}:${MESH_SUBSTRATE_TARGET}:${p} &`
    )
    .join(" ");
  return [
    {
      name: MESH_COMPANION,
      image: input.images.mesh,
      env: {
        TS_AUTHKEY: input.authKey,
        // Our control URL only, TLS on 443 (HR 22). NO --advertise-tags: the key carries the node tag.
        TS_EXTRA_ARGS: `--login-server=${input.controlUrl}`,
        TS_HOSTNAME: input.deviceName,
        TS_USERSPACE: "true",
        TS_AUTH_ONCE: "true",
        TS_SOCKS5_SERVER: `:${MESH_SOCKS_PORT}`,
        // No TS_STATE_DIR: in-memory state, so a restart joins again with the same reusable,
        // ephemeral key (HR 7) and no device state outlives the container.
        TS_SOCKET: "/tmp/tailscaled.sock",
        HOME: "/tmp",
        // No log upload or support contact with a Tailscale-operated host (HR 21).
        TS_NO_LOGS_NO_SUPPORT: "true",
      },
      command: ["/bin/sh", "-c"],
      args: [
        [
          // Not a Kubernetes pod: containerboot must not look for a kube Secret.
          "unset KUBERNETES_SERVICE_HOST KUBERNETES_SERVICE_PORT",
          asCompanionUser("exec /usr/local/bin/containerboot"),
        ].join("\n"),
      ],
      cpuUnits: 0.1,
      memoryMi: 128,
      storageMi: 256,
      expose: [{ port: MESH_SOCKS_PORT, as: MESH_SOCKS_PORT, global: false }],
    },
    {
      name: MESH_SUBSTRATE_HOST,
      image: input.images.substrate,
      command: ["/bin/sh", "-c"],
      args: [asCompanionUser(`${forwards} wait`)],
      cpuUnits: 0.1,
      memoryMi: 64,
      storageMi: 256,
      expose: input.ports.map((p) => ({ port: p, as: p, global: false })),
    },
  ];
}

/** In-memory device-health state of one live attempt. Lost on restart, which rolls nothing. */
export interface DeviceWatchEntry {
  /** First read in the current run of consecutive successful reads with no online device. */
  readonly absentSince?: number | undefined;
  /** First read in the current run with more than one online device. */
  readonly cloneSince?: number | undefined;
}

export interface DeviceReadVerdict {
  readonly next: DeviceWatchEntry;
  readonly online: number;
  readonly devices: number;
  /** Absent for `DEVICE_ABSENT_ROLL_MS` over consecutive successful reads. */
  readonly roll: boolean;
  /** More than one online device for `DEVICE_CLONE_ALERT_MS`. */
  readonly clone: boolean;
}

/**
 * HR 8 cap: workloads whose newest device-driven roll (an attempt `lost` with `mesh_device_absent`) has
 * no newer `active` attempt yet, counted for at most `DEVICE_ROLL_INFLIGHT_MS`, so a parked replacement
 * cannot hold the env's roll budget forever. Each entry is one workload's attempts, newest first.
 */
export function deviceRollsInFlight(
  workloads: readonly (readonly AttemptRow[])[],
  now: number
): number {
  let n = 0;
  for (const attempts of workloads) {
    const i = attempts.findIndex(
      (a) => a.phase === "lost" && a.error === MESH_DEVICE_ABSENT
    );
    const roll = attempts[i];
    if (!roll || now - roll.updatedAt.getTime() >= DEVICE_ROLL_INFLIGHT_MS)
      continue;
    if (!attempts.slice(0, i).some((a) => a.phase === "active")) n++;
  }
  return n;
}

/** The env's `substrate-gw` device, if Headscale lists one (tags exactly `[tag:substrate]`). */
export function substrateGateway(
  devices: readonly MeshDevice[]
): MeshDevice | undefined {
  return devices.find(
    (d) => d.tags.length === 1 && d.tags[0] === SUBSTRATE_TAG
  );
}

/**
 * HR 8 over ONE successful read: every device that joined with the attempt's key counts (ephemeral
 * restarts make new devices). The caller resets every entry on a failed read or an offline gateway.
 */
export function readAttemptDevices(input: {
  readonly entry: DeviceWatchEntry | undefined;
  readonly headscaleKeyId: string;
  readonly devices: readonly MeshDevice[];
  /** `createdAt` of the online `substrate-gw` (a wipe or re-enrollment restarts the count). */
  readonly gatewayCreatedAt: number | undefined;
  readonly now: number;
}): DeviceReadVerdict {
  const mine = input.devices.filter(
    (d) => d.headscaleKeyId === input.headscaleKeyId
  );
  const online = mine.filter((d) => d.online).length;
  let absentSince = input.entry?.absentSince;
  if (online > 0) absentSince = undefined;
  else {
    absentSince ??= input.now;
    if (
      input.gatewayCreatedAt !== undefined &&
      input.gatewayCreatedAt > absentSince
    )
      absentSince = input.now;
  }
  const cloneSince =
    online > 1 ? (input.entry?.cloneSince ?? input.now) : undefined;
  return {
    next: { absentSince, cloneSince },
    online,
    devices: mine.length,
    roll:
      absentSince !== undefined &&
      input.now - absentSince >= DEVICE_ABSENT_ROLL_MS,
    clone:
      cloneSince !== undefined &&
      input.now - cloneSince > DEVICE_CLONE_ALERT_MS,
  };
}
