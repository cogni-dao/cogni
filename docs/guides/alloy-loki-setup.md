---
id: alloy-loki-setup-guide
type: guide
title: Alloy + Grafana Cloud Loki Setup
status: draft
trust: draft
summary: How to set up Alloy log forwarding to Grafana Cloud Loki, including Grafana Cloud account setup, environment config, and verification.
read_when: Setting up or troubleshooting the Alloy → Grafana Cloud Loki log pipeline.
owner: derekg1729
created: 2026-02-06
verified: 2026-04-13
tags: [observability, infra]
---

# Alloy + Grafana Cloud Loki Setup

## When to Use This

You are setting up or troubleshooting the Alloy log + metrics pipeline that forwards container, pod, and host observability data to Grafana Cloud (Loki + Mimir).

**v0 deploy model: one Alloy per VM, via Docker Compose.** Each env's VM runs a single `alloy` compose service defined in `infra/compose/runtime/docker-compose.yml` with config file `infra/compose/runtime/configs/alloy-config.metrics.alloy`. The config is delivered to the VM by `scripts/ci/deploy-infra.sh`, dispatched via `.github/workflows/promote-and-deploy.yml`. What it ships:

- **Docker container logs** for the runtime allowlist, including Caddy JSON runtime/access logs emitted to stdout — tailed via `/var/run/docker.sock`
- **K3s pod logs** from `/var/log/pods` for `cogni-*`, `argocd`, and `kube-system` namespaces — so Argo CD sync events and kubelet/coredns/kube-proxy logs are queryable in Loki without SSH
- **App metrics** — operator and scheduler-worker `/api/metrics` via bearer-token Prometheus scrape
- **Docker cAdvisor per-container metrics** via `prometheus.exporter.cadvisor`
- **Host metrics** via `prometheus.exporter.unix` (`/proc`, `/sys`, `/`), including conntrack occupancy and TCP listen-overflow/SYN-cookie counters

Host `journald` is not currently shipped. Kernel/network failure diagnosis must use
the bounded node-exporter counters above until a least-privilege journal reader is
designed; do not assume `{source="journald"}` exists.

There is no k8s DaemonSet Alloy on v0. A speculative one landed in PR #864 and was reverted in PR #869 because on a single-VM deploy it duplicated the compose pod-log tail at `/var/log/pods`, producing 2× ingest to Grafana Cloud with no added coverage. A multi-node Alloy topology (DaemonSet for node-local collection + singleton Deployment for cluster-scoped scraping like kube-state-metrics and argocd-metrics) is future work, deferred until the k3s cluster splits past a single VM.

Promtail is deprecated (EOL March 2, 2026) — Alloy is the replacement.

## Preconditions

- [ ] Docker running
- [ ] Grafana Cloud account (free tier available)
- [ ] `.env.local` or `.env.runtime.local` configured

## Steps

### Current State

✅ **V1 Complete:** Structured logging with Pino in application code

- JSON logs to stdout
- RequestContext with reqId, session, routeId
- Event schemas (AiLlmCallEvent, PaymentsEvent)
- See: [Observability Spec](../spec/observability.md)

✅ **V2 Complete:** Log collection and aggregation

- Alloy forwards logs to Grafana Cloud Loki
- No self-hosted Loki required
- Logs queryable via Grafana Cloud interface

### Goal

Minimal viable log collection with Grafana Cloud:

1. Replace Promtail with Alloy
2. Configure Alloy to scrape container logs via Docker socket
3. Forward logs to Grafana Cloud Loki (managed service)
4. Verify logs flow: App → Docker → Alloy → Grafana Cloud
5. Query and visualize logs in Grafana Cloud

**Deferred to later PRs:**

- Grafana dashboards
- Alert rules
- Advanced filtering (health check noise)
- Structured metadata extraction
- Trace collection (OTLP)

### Design Decisions

### 1. Label Cardinality (STRICT)

**Labels** (indexed, low-cardinality):

- `app` - Application name (e.g., "cogni-template")
- `env` - Environment (dev, test, prod)
- `service` - Docker Compose service name (mapped from compose_service)
- `stream` - stdout/stderr

**JSON fields** (not labels, query with `| json`):

- `reqId` - Request ID (high cardinality)
- `userId` - User ID (high cardinality)
- `billingAccountId` - Billing account (high cardinality)
- `attemptId` - Payment attempt ID (high cardinality)
- `level` - Log level (info, warn, error)
- `msg` - Log message
- `time` - Timestamp

**Rationale:** Loki indexes labels; high-cardinality labels destroy performance. Keep cardinality < 100 per label.

### 2. Version Pinning

- **Alloy:** `grafana/alloy:v1.9.2` (Dec 2024 - stable 1.9.x branch, includes eBPF fixes and better component compatibility)
- **Grafana Cloud Loki:** Managed service (automatically updated by Grafana)

**Why these versions:**

- Alloy v1.9.2: Latest 1.9.x with fixes for validation and profile collection; avoids breaking changes from v1.9.0
- Grafana Cloud: No version management required, always up-to-date

**Update policy:** Review Alloy quarterly; test in dev before promoting to prod. Never use `:latest`.

### 3. Security

- Alloy UI: `127.0.0.1:12345` (internal only, not exposed publicly)
- Docker socket: read-only mount (`:ro`)
- No `/var/lib/docker/containers` mount (using docker discovery, not file scraping)
- Grafana Cloud: Basic auth with user ID and API key (credentials via environment variables)

### 4. Storage

- **Grafana Cloud:** Managed storage (no local volumes required for Loki)
- **Alloy positions:** Named volume `alloy_data` (offset tracking)

### Step 1: Setup Grafana Cloud Account

1. Sign up at https://grafana.com/products/cloud/ (free tier available)
2. Navigate to: **Connections → Data Sources → Loki**
3. Note the following credentials:
   - **URL**: Push endpoint (e.g., `https://logs-prod-us-central1.grafana.net/loki/api/v1/push`)
   - **User ID**: Numeric value shown in the interface
4. Generate an API key:
   - Click **"Generate now"** in the Loki data source page
   - Grant `logs:write` permission
   - Save the API key securely (starts with `glc_`)

### Step 2: Configure Environment Variables

Add to your `.env.local` or `.env.runtime.local`:

```bash
GRAFANA_CLOUD_LOKI_URL="https://logs-prod-us-central1.grafana.net/loki/api/v1/push"
GRAFANA_CLOUD_LOKI_USER="123456"  # Your numeric user ID
GRAFANA_CLOUD_LOKI_API_KEY="glc_your_api_key_here"  # API key with logs:write
```

These variables are already configured in:

- `.env.local.example` (local development template)
- `docker-compose.yml` and `docker-compose.dev.yml` (Alloy service environment section)

### Step 3: Alloy Configuration

The live Alloy configuration is at `infra/compose/runtime/configs/alloy-config.metrics.alloy` — the logs+metrics variant shipped to `preview` and `production` VMs via `scripts/ci/deploy-infra.sh` during `promote-and-deploy.yml`. A simpler logs-only variant for local dev lives at `infra/compose/configs/alloy-config.alloy`.

> **Note:** The `candidate-a` VM is currently operated by `candidate-flight.yml`, which only rsyncs k8s overlays — it does **not** run `deploy-infra.sh`. Compose changes in `infra/compose/**` therefore land on `candidate-a` only via the initial `provision-test-vm.sh` bootstrap. PRs that touch the Alloy config cannot be validated pre-merge on `candidate-a` until that gap is closed (tracked under bug.0312).

Key knobs in the metrics config:

- **Docker container allowlist** — `(app|litellm|caddy|scheduler-worker|temporal|openclaw-gateway|llm-proxy-openclaw|autoheal)` on the `loki.source.docker` side
- **K3s pod namespace allowlist** — `(cogni-.*|argocd|kube-system)` applied as a `stage.match` drop filter inside `loki.process.k8s_pod_logs` (wide file glob, pipeline-level filter)
- **Strict label cardinality** — `{app, env, service, stream}` for docker logs; `{app, env, source, namespace, pod, container, service}` for k8s pod logs
- **Grafana Cloud endpoint** — `sys.env("LOKI_WRITE_URL")` with basic auth via env vars
- **Prometheus scrapes** — app `/api/metrics`, scheduler-worker, docker cAdvisor, unix host exporter

See the config file for the full pipeline.

### Step 4: Deploy Stack

```bash
cd infra/services/runtime
docker compose --env-file .env.runtime.local down
docker compose --env-file .env.runtime.local up -d
```

Wait ~30 seconds for services to stabilize.

### Implementation History

1. Setup Grafana Cloud account and get credentials
2. Update `docker-compose.yml` and `docker-compose.dev.yml`:
   - Remove `loki` service (using Grafana Cloud)
   - Replace `promtail` with `alloy`
   - Add Grafana Cloud env vars to alloy service
   - Add `alloy_data` volume definition
3. Create `configs/alloy-config.alloy` with Grafana Cloud endpoint
4. Test locally with Grafana Cloud
5. Update documentation:
   - `docs/spec/observability.md` — Complete Grafana Cloud setup guide
   - `infra/compose/AGENTS.md` — Added setup instructions
6. Standardize environment files:
   - Merge `.env.example` into `.env.local.example`
   - Delete `.env.example`
   - Update all references in docs and scripts
7. Widen k8s pod-log namespace allowlist to include `argocd` and `kube-system` (PR #869), replacing the earlier speculative k8s-side DaemonSet approach (PR #864, reverted).

## Verification

**Check Alloy UI:**

Open http://127.0.0.1:12345 in your browser:

- Verify `discovery.docker.containers` shows discovered targets
- Verify `loki.write.grafana_cloud_loki` shows healthy endpoint status
- Check for any error messages in component status

**Check Grafana Cloud:**

1. Navigate to https://your-org.grafana.net/a/logs (Explore → Loki)
2. Run LogQL queries:
   - `{app="cogni-template"}` — all logs from this env
   - `{service="app"}` — operator logs only (docker source)
   - `{source="k8s", namespace=~"cogni-.*"}` — k3s app pod logs
   - `{source="k8s", namespace="argocd"}` — Argo CD sync/reconcile events
   - `{source="k8s", namespace="kube-system"}` — kubelet / coredns / kube-proxy
   - `{service="caddy"}` — edge runtime + access logs
   - `{service="app"} | json | level="error"` — filter errors

**Validation Checklist:**

- [ ] Alloy UI accessible at http://127.0.0.1:12345
- [ ] Alloy discovers docker containers (check UI targets)
- [ ] On a k3s host: `local.file_match.k8s_pods` shows >0 targets
- [ ] Grafana Cloud shows `app="cogni-template"` logs from Docker and k8s sources
- [ ] `{env="<env>",service="caddy"}` returns an access log after a public probe
- [ ] `{source="k8s", namespace="argocd"}` returns Argo CD controller/server logs
- [ ] `{source="k8s", namespace="kube-system"}` returns kubelet/coredns/kube-proxy logs
- [ ] Existing `{namespace=~"cogni-.*"}` logs still flow (no regression)
- [ ] High-cardinality fields (reqId) queryable via `| json`

## Troubleshooting

### Problem: No logs in Grafana Cloud

**Solution:**

1. Check Alloy UI (http://127.0.0.1:12345):
   - Component status shows errors?
   - Authentication failing?
2. Check Alloy logs: `docker logs alloy | tail -50`
3. Verify environment variables in container:
   ```bash
   docker exec alloy env | grep GRAFANA_CLOUD
   ```
4. Verify app is logging: `docker logs app | head`

### Problem: Authentication errors

**Solution:**

1. Verify credentials are correct in `.env` file
2. Check API key has `logs:write` permission in Grafana Cloud
3. Verify URL format includes `/loki/api/v1/push` path

### Problem: Labels missing

**Solution:**

1. Verify `APP_ENV` is set: `docker exec alloy env | grep APP_ENV`
2. Check Alloy relabeling rules in `configs/alloy-config.alloy`
3. Query in Grafana Cloud: `{app="cogni-template"}` to inspect labels

### Problem: argocd or kube-system logs missing

**Solution:**

1. Confirm the host actually runs k3s — `ls /var/log/pods/` on the VM should show directories like `argocd_argocd-server-*`, `kube-system_coredns-*`, `cogni-candidate-a_operator-*`
2. Confirm `/var/log/pods:/var/log/pods:ro` is mounted into the alloy container (check `docker inspect alloy | jq '.[0].Mounts'`)
3. Confirm the `stage.match` selector in `loki.process.k8s_pod_logs` includes the namespace you expect — the allowlist is `{namespace!~"cogni-.*|argocd|kube-system"}` as a drop filter, so adding a new namespace means editing that regex
4. Check `local.file_match.k8s_pods` target count in the Alloy UI — if it shows 0, the glob isn't matching any files (e.g. file permissions, or host isn't a k3s host)

## Related

- [Observability Spec](../spec/observability.md) — structured logging, tracing, event schemas
- [Observability Hardening Project](../../work/projects/proj.observability-hardening.md) — future enhancements (filtering, dashboards, alerts, traces)
- [Official Alloy Tutorial: Send Logs to Loki](https://grafana.com/docs/alloy/latest/tutorials/send-logs-to-loki/)
- [loki.source.docker Component](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/)
- [discovery.docker Component](https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.docker/)
- [Loki Label Best Practices](https://grafana.com/docs/loki/latest/best-practices/)
