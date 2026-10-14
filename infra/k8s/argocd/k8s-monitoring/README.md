<!--
SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
SPDX-FileCopyrightText: 2026 Cogni-DAO
-->

# k8s-monitoring — in-cluster Kubernetes state collector (bug.5165)

Makes k3s **container-level state** observable in Grafana Cloud so an
`OOMKilled` / restart / terminated-reason / unschedulable pod is answerable in
**one Mimir query** instead of SSH-and-guess (bug.5165 / bug.5165 prod-observability gap).

## What it ships

| Source                                                                  | Series                                                                                                                                                                                                                                                           | Answers                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **kube-state-metrics** (Helm chart 8.5.0, KSM v2.20.0)                  | `kube_pod_container_status_last_terminated_reason`, `kube_pod_container_status_restarts_total`, `kube_pod_container_status_waiting_reason`, `kube_pod_status_phase`, `kube_pod_status_unschedulable`, `kube_deployment_status_*`, `kube_node_status_condition` … | _Was it OOMKilled? how many restarts? stuck Pending / unschedulable?_ |
| **kubelet + cAdvisor** (Grafana Alloy, scraped via the apiserver proxy) | `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes`, `container_oom_events_total`, `container_cpu_usage_seconds_total` …                                                                                                                   | _Which pod's container is near its mem limit / actually OOMed?_       |

Example queries once live:

```promql
# Every OOMKilled container in production, last 6h
kube_pod_container_status_last_terminated_reason{env="production", reason="OOMKilled"}

# Restart counts climbing
increase(kube_pod_container_status_restarts_total{env="production"}[15m]) > 0

# Pods that can't schedule
kube_pod_status_unschedulable{env="production"} == 1

# Container memory vs its limit
container_memory_working_set_bytes{source="k8s", env="production"}
  / container_spec_memory_limit_bytes{source="k8s", env="production"}
```

## Dedupe vs the Compose Alloy — how double-shipping is avoided

The Compose Alloy (`infra/compose/runtime/configs/alloy-config.metrics.alloy`)
already remote-writes to the **same** Grafana Cloud Mimir tenant. This stack is
scoped to only the series it structurally cannot see, and overlaps **nothing**:

1. **`node_exporter` (`node_*`) — NOT deployed here.** The Compose Alloy
   (`prometheus.exporter.unix`) is the sole shipper of host node metrics. This
   stack ships no `node-exporter` / `prometheus-node-exporter` at all, so there
   is zero `node_*` duplication.
2. **cAdvisor — disjoint container universes.** The Compose Alloy's
   `prometheus.exporter.cadvisor` reads `docker.sock`, which sees only the
   **compose** containers (litellm, postgres, temporal, openfga, caddy, alloy …).
   k3s pods run under **containerd**, invisible to it — that is the gap. This
   stack scrapes the **kubelet's** cAdvisor, which sees only **k3s pods**. The
   two sets never intersect, and even where metric _names_ coincide the label
   sets differ (compose carries `service=…`; these carry `namespace/pod/container`
   plus `source="k8s"`), so no series collides.
3. **kube-state-metrics — brand new.** Nothing in the Compose Alloy emits
   `kube_*`; no overlap possible.

Active-series growth is further bounded by an explicit `keep` allowlist in the
Alloy config (only the metrics that answer "why did this container die / not
schedule"), mirroring the Compose Alloy's cardinality policy.

## Layout & delivery

```
base/                 env-agnostic: KSM Helm chart + Alloy (Deployment + config + RBAC) + ExternalSecret
overlays/<env>/       pins DEPLOY_ENVIRONMENT (the `env` label) + the OpenBao path (cogni/<env>/_shared)
```

Each overlay is delivered by a control-plane Argo CD Application
(`infra/k8s/argocd/control-plane/<env>/k8s-monitoring-application.yaml`), adopted
by that env's root app-of-apps — the same delivery shape as the Crossplane
control-plane apps. candidate-a tracks `deploy/candidate-a-control-plane`;
preview/production track `main`.

Credentials (`PROMETHEUS_REMOTE_WRITE_URL` / `_USERNAME` / `_PASSWORD`) come from
OpenBao `cogni/<env>/_shared` via ESO (`ClusterSecretStore/openbao-backend`) into
the `grafana-cloud-metrics` Secret — the same values the Compose Alloy reads from
the VM env.

## Validation

CI's `check-gitops-manifests.sh` builds only `infra/k8s/overlays/*` and without
`--enable-helm`, so it does **not** render this Helm-in-kustomize dir. Render it
explicitly (no cluster needed):

```bash
kustomize build --enable-helm infra/k8s/argocd/k8s-monitoring/overlays/candidate-a
```

Once synced, confirm series arrive:

```promql
count(kube_pod_info{env="candidate-a"})                         # KSM up
count(container_memory_working_set_bytes{source="k8s", env="candidate-a"})  # cAdvisor up
up{job=~"kubelet|cadvisor|kube-state-metrics", env="candidate-a"}
```

## Gated on the Wave-0B VM resize

The current single k3s node is RAM-constrained (~5.8 GB). KSM + Alloy add ~2 more
pods (requests ~35m CPU / ~192Mi). **Do not assume the un-resized host can absorb
this** — sync to candidate-a/production only after the Wave-0B resize (story.5045).

## Out of scope (sibling tasks under story.5045)

External synthetics, SLO burn alerts, Tempo/traces, Akash-node log shipping, and
dashboards are deliberately **not** built here.
