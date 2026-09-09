---
id: vm-watchdog
type: spec
title: VM Watchdog
status: draft
spec_state: draft
trust: draft
summary: Docker HEALTHCHECK on /livez + autoheal sidecar auto-restarts unhealthy app containers; resource limits prevent unbounded OOM
read_when: Implementing the watchdog, modifying docker-compose.yml, changing health probe endpoints, debugging auto-restarts
implements: proj.reliability
owner: derekg1729
created: 2026-02-10
verified: null
tags:
  - infra
  - reliability
  - observability
---

# VM Watchdog

> Docker HEALTHCHECK probes `/livez` inside the app container. When the health check fails (event loop blocked, process hung), Docker marks the container `unhealthy`. An autoheal sidecar detects unhealthy containers and restarts them. Resource limits prevent unbounded memory growth. Autoheal logs flow to Loki via Alloy for self-observability.

### Key References

|                |                                                                                  |                                        |
| -------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| **Project**    | [proj.reliability](../../work/projects/proj.reliability.md)                      | Reliability roadmap (P0 watchdog item) |
| **Spec**       | [observability-requirements](./observability-requirements.md)                    | HEARTBEAT_LIVENESS invariant           |
| **Spec**       | [observability](./observability.md)                                              | Logging and metrics architecture       |
| **Postmortem** | [2026-02-07 Production VM Loss](../postmortems/2026-02-07-production-vm-loss.md) | Incident that motivated this design    |
| **OSS**        | [willfarrell/autoheal](https://hub.docker.com/r/willfarrell/autoheal)            | Docker container auto-restart          |

## Design

### Architecture

```
Docker daemon
  │
  ├── app container
  │     └── HEALTHCHECK: curl /livez every 10s, timeout 5s, 3 retries
  │           └── after 3 failures → Docker marks container "unhealthy"
  │
  ├── autoheal container (label-gated, hardened)
  │     └── polls Docker API every 5s for unhealthy containers
  │           └── finds app (label autoheal=true) → docker restart app
  │           └── logs restart to stdout → Alloy → Loki
  │
  └── Alloy (already running)
        └── scrapes all container logs via docker.sock
        └── autoheal logs appear as service="autoheal" in Loki
```

### Why `/livez` not `/readyz`

| Endpoint  | Checks                              | Fails during deploy?           | Catches event loop hang? |
| --------- | ----------------------------------- | ------------------------------ | ------------------------ |
| `/readyz` | Env, secrets, DB, Temporal, EVM RPC | Yes (DB down during migration) | Yes (timeout)            |
| `/livez`  | HTTP stack alive (zero deps)        | **No**                         | Yes (timeout)            |

Using `/livez` for the HEALTHCHECK eliminates the need for a deploy lockfile. During deployment, the app container is recreated by `compose up -d`. The new container's HEALTHCHECK starts fresh with its `start_period` grace window. `/livez` only fails when the Node.js process cannot handle HTTP — exactly the failure mode from the Feb 7-8 incidents (OTel `spawnSync` blocking the event loop).

`/readyz` remains the correct probe for external uptime monitors and deploy canaries (they should detect dependency failures). The Docker HEALTHCHECK uses `/livez` because its job is liveness, not readiness.

### HEALTHCHECK Tuning

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/livez || exit 1
```

| Parameter      | Value | Rationale                                                                                                  |
| -------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `interval`     | 10s   | Frequent enough to detect hangs quickly                                                                    |
| `timeout`      | 5s    | The OTel spawnSync calls blocked for seconds; 5s catches them. Must be > p99 livez latency (~1ms)          |
| `start_period` | 30s   | App needs time for Next.js boot + DI container init                                                        |
| `retries`      | 3     | 3 failures \* 10s interval = ~30s to `unhealthy`. Combined with autoheal poll (5s), restart within ~35-60s |

The Dockerfile HEALTHCHECK is also overridden in `docker-compose.yml` for the `app` service to ensure consistency across environments.

### HEALTHCHECK Tooling

Healthcheck `test` commands must use tools available in the container image. Common pitfall: `wget` and `curl` are not present in slim images like `node:20-bookworm-slim`.

| Image base                     | Available tool   | Example                                                                                                                                  |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `node:*-bookworm-slim`         | `node -e`        | `node -e "require('http').get('http://localhost:9000/livez',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"` |
| Next.js (Dockerfile with curl) | `curl`           | `curl -fsS http://localhost:3000/livez`                                                                                                  |
| `postgres:*`                   | `pg_isready`     | `pg_isready -U $USER`                                                                                                                    |
| `python` (LiteLLM)             | `python3 urllib` | `python3 -c "import urllib.request..."`                                                                                                  |
| `alpine` (nginx)               | `wget`           | `wget -qO- http://127.0.0.1:8080/health`                                                                                                 |

### Autoheal Sidecar

[willfarrell/autoheal](https://hub.docker.com/r/willfarrell/autoheal) is a lightweight Alpine container (~5MB) that:

1. Polls the Docker API for containers with `health_status=unhealthy`
2. Filters by label (`autoheal=true`)
3. Restarts matching containers
4. Logs restarts to stdout

**Compose definition:**

```yaml
autoheal:
  image: willfarrell/autoheal:<digest-pin>
  restart: always
  network_mode: "none"
  read_only: true
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true
  environment:
    - AUTOHEAL_CONTAINER_LABEL=autoheal
    - AUTOHEAL_INTERVAL=5
    - AUTOHEAL_START_PERIOD=60
    - AUTOHEAL_DEFAULT_STOP_TIMEOUT=10
    - DOCKER_SOCK=/var/run/docker.sock
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  labels:
    - "autoheal=false"
```

**Hardening rationale:**

- `network_mode: "none"` — autoheal only needs the Docker socket, never the network
- `read_only: true` — no filesystem writes needed
- `cap_drop: ALL` — no Linux capabilities needed (Docker socket access is via group/file permissions)
- `security_opt: no-new-privileges` — prevent privilege escalation
- `volumes: docker.sock:ro` — read-only socket mount (autoheal uses Docker API `POST /containers/{id}/restart`, which works on read-only socket mounts)
- `labels: autoheal=false` — prevent autoheal from restarting itself
- Image pinned by digest — no tag drift

**Label-gating:** Only containers with `labels: autoheal: "true"` get restarted. Every long-running service with a `healthcheck` defined defaults to `autoheal=true`. Autoheal only acts on containers Docker has marked `unhealthy` (requires a configured healthcheck — services without one are unaffected by the label).

**Exceptions** (must NOT have `autoheal=true`):

- `autoheal` itself — `autoheal=false` to prevent self-restart loops
- One-shot containers (`git-sync`, `repo-init`, `db-provision`, `db-migrate`) — `restart: no`, not long-running

**Deploy interaction:** `deploy.sh` stops autoheal before `compose up -d` to prevent a race condition — autoheal can restart a container between compose's stop and remove steps, causing "cannot remove container: container is running". Compose recreates autoheal as part of the stack, so no explicit re-enable is needed.

### Resource Limits

```yaml
app:
  mem_limit: 512m
  memswap_limit: 768m
```

| Limit           | Value | Rationale                                                                                   |
| --------------- | ----- | ------------------------------------------------------------------------------------------- |
| `mem_limit`     | 512m  | Next.js base (~150MB) + OTel SDK (~30MB) + DI + request overhead. Prevents unbounded growth |
| `memswap_limit` | 768m  | 256MB swap headroom. Allows brief spikes without OOM kill                                   |

When the app hits `mem_limit`, the kernel OOM-kills the process. Docker `restart: always` then restarts it. This prevents the Feb 7 failure mode where unbounded memory growth exhausted the 2GB VM.

### Observability

Autoheal logs to stdout. Alloy already scrapes all Docker container logs via the `docker.sock` mount. Autoheal restart events appear in Loki automatically:

```logql
{app="cogni-template", service="autoheal"} |= "Restarting"
```

**Grafana alerts (future, not in this task):**

- Container restart count delta > 0 in 5 min window
- Container health status = unhealthy for > 60s
- App RSS vs mem_limit approaching threshold (> 85%)

## Goal

Define the contract for auto-recovery when the app container becomes unresponsive, using standard Docker health checks and an OSS autoheal sidecar. No bespoke scripts, no systemd units, no deploy lockfiles.

## Non-Goals

- Detecting OOM root cause (that's `spec.observability-requirements` BELOW_APP_ATTRIBUTION + cAdvisor)
- External uptime monitoring / alerting (separate proj.reliability deliverable)
- Grafana alert rule configuration (documented above for future implementation)
- Restarting non-app services (litellm, postgres, temporal manage their own health)

## Invariants

| Rule                       | Constraint                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WATCHDOG_LIVEZ_NOT_READYZ  | Docker HEALTHCHECK must probe `/livez` (liveness), never `/readyz` (readiness)                                                                                                                                                                                                                                                                                                   |
| WATCHDOG_RECOVERY_BOUND    | App container must be restarted within 90s of livez becoming unreachable                                                                                                                                                                                                                                                                                                         |
| WATCHDOG_LABEL_GATE        | Every long-running **stateless** service with a healthcheck gets `autoheal: "true"`. Excluded: autoheal itself, one-shot containers, and **stateful data stores** (`postgres`, `temporal-postgres`, `doltgres`, `redis`, `tigerbeetle`), which carry `autoheal: "false"` — restarting a database mid-recovery converts a survivable bounce into an unrecoverable loop (bug.5105) |
| WATCHDOG_AUTOHEAL_HARDENED | Autoheal runs with network_mode:none, read_only:true, cap_drop:ALL, no-new-privileges, digest-pin                                                                                                                                                                                                                                                                                |
| WATCHDOG_AUTOHEAL_NO_SELF  | Autoheal container must have `autoheal: "false"` label to prevent self-restart loops                                                                                                                                                                                                                                                                                             |
| WATCHDOG_MEM_BOUNDED       | App container must have explicit `mem_limit` and `memswap_limit` set                                                                                                                                                                                                                                                                                                             |
| WATCHDOG_LOGS_TO_LOKI      | Autoheal container logs must be collected by Alloy and visible in Loki                                                                                                                                                                                                                                                                                                           |

### File Pointers

| File                                       | Purpose                                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| `Dockerfile`                               | HEALTHCHECK definition (livez, timeout, retries)          |
| `infra/compose/runtime/docker-compose.yml` | autoheal service, app labels, app mem_limit, HEALTHCHECK  |
| `src/app/(infra)/livez/route.ts`           | Liveness probe (dependency-free)                          |
| `src/app/(infra)/readyz/route.ts`          | Readiness probe (full dependency chain, NOT for watchdog) |

## Acceptance Checks

**Automated (CI):**

```bash
# Dockerfile HEALTHCHECK uses livez
grep -q '/livez' Dockerfile

# Autoheal service exists in compose
grep -q 'autoheal' infra/compose/runtime/docker-compose.yml

# App has mem_limit set
grep -q 'mem_limit' infra/compose/runtime/docker-compose.yml

# App has autoheal label
grep -q 'autoheal.*true' infra/compose/runtime/docker-compose.yml
```

**Manual (on VM after deploy):**

```bash
# Autoheal is running
docker ps --filter name=autoheal --format '{{.Status}}'

# App HEALTHCHECK is passing
docker inspect --format='{{.State.Health.Status}}' cogni-runtime-app-1

# Simulate hang: pause the app container
docker pause cogni-runtime-app-1
# Wait ~60-90s, verify Docker marks unhealthy then autoheal restarts:
docker events --filter event=health_status --filter event=restart --since 2m
# Verify Loki shows autoheal restart:
# {service="autoheal"} |= "Restarting"

# Verify memory limit is enforced
docker stats --no-stream cogni-runtime-app-1 --format '{{.MemUsage}}'
```

## Open Questions

- [ ] What is the current pinned digest for `willfarrell/autoheal:latest`? Resolve before implementation.
- [ ] Should `mem_limit` be 512m or higher? Profile production RSS to confirm.

## Related

- [observability-requirements](./observability-requirements.md) — HEARTBEAT_LIVENESS invariant
- [observability](./observability.md) — structured logging, Alloy log collection
- [proj.reliability](../../work/projects/proj.reliability.md) — parent project
- [Postmortem: Feb 7-8 outages](../postmortems/2026-02-07-production-vm-loss.md) — incident that motivated this
