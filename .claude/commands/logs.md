It's time to collect and analyze logs for the problem at hand.

Use current context to infer the environment, or get user input: #$PROBLEM

> **Logs vs traces.** This skill reads **Loki** (infra + app request logs). For
> AI graph runs — LLM/tool calls, token cost, bad-but-not-crashed answers — use
> [`/traces`](traces.md) (Langfuse). A request rejected before the graph runs
> (auth, Zod 400) is here in Loki; a graph that ran but answered wrong is there.

Follow this systematic approach:

## 1. Identify the Environment

Ask the user which environment to investigate, or infer from context:

- **local** - User is running `pnpm docker:stack` (app containerized)
- **preview** - Staging/PR environment
- **production** - Live production

**MCP Server Selection:**

- Local: Use MCP tools for `graphana-local`
- Preview/Production: Use MCP tools for `graphana` (cloud)

**MCP fallback — curl helper when MCP is down:** use
[`scripts/loki-query.sh`](../../scripts/loki-query.sh). It reads
`GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` from your env (or auto-sources
`.env.canary`/`.env.local`) and hits the Loki `query_range` API directly.
Example:

```bash
scripts/loki-query.sh '{env="candidate-a",service="app",pod=~"poly-node-app-.*"} | json | route="poly.wallet.connect"' 30 100 | jq
```

The LogQL syntax is identical to the MCP path; output is the raw Loki JSON.

**Important:** `dev:stack` does NOT collect app logs, only other services (app runs outside Docker). Only `docker:stack` collects all logs locally.

### CI Logs (GitHub Actions)

For CI failures, use `env="ci"`:

```logql
# All CI logs
{app="cogni-template", env="ci"}

# Specific workflow (e.g., "CI", "Staging Preview")
{app="cogni-template", env="ci", workflow="CI"}

# Specific job (e.g., "stack-test", "build-image")
{app="cogni-template", env="ci", job="stack-test"}

# Specific run (find run_id in GitHub Actions URL)
{app="cogni-template", env="ci", run_id="12345678901"}
```

**Available labels:** `workflow`, `job`, `ref`, `run_id`, `attempt`, `sha8`

## 2. Discover Available Data

1. **List datasources** to get UID:

   ```
   list_datasources(type: "loki")
   ```

2. **List available services:**

   ```
   list_loki_label_values(datasourceUid, labelName: "service")
   ```

   App + infra (host alloy ships Compose container stdout, allow-listed via
   `infra/compose/runtime/configs/alloy-config.{,metrics.}alloy`):
   - app pods: `app`, `scheduler-worker`, `migrate`, `migrate-doltgres`
   - infra/compose: `litellm`, `caddy`, `temporal`, `autoheal`, `db-backup`,
     `openclaw-gateway`, `llm-proxy-openclaw`, `alloy-k8s-events`
   - argocd controllers: `argocd-application-controller`,
     `argocd-applicationset-controller`, `argocd-image-updater`,
     `argocd-server`, `argocd-repo-server`, `argocd-notifications-controller`
   - CI: `infra-deployment` (and `env="ci"` for workflow logs)

   New compose services don't ship logs until added to that allowlist regex —
   if `service=<svc>` returns nothing, check the regex first, not Loki.

3. **List all queryable labels:**
   ```
   list_loki_label_names(datasourceUid)
   ```

**Our Configured Labels (indexed, low-cardinality):**

- `app` - Always "cogni-template"
- `env` - Environment: local | candidate-a | preview | production | ci
- `service` - Service name (see #2 above for full list — app pods, infra
  compose containers, argocd controllers all share this label)
- `source` - `k8s` (in-cluster pod logs from cAdvisor) | `k8s-events`
  (kubernetes Events stream — pod OOMKilled, probe failures, evictions,
  rollout events; shipped by `alloy-k8s-events`). Use `source="k8s-events"`
  when investigating "why did the pod restart" / "why did probe fail".
- `stream` - stdout | stderr (runtime only, not CI)

**CI-specific labels** (when `env="ci"`):

- `workflow` - GitHub workflow name
- `job` - Job name
- `ref` - Branch/tag name
- `run_id` - GitHub run ID
- `attempt` - Retry attempt
- `sha8` - 8-char commit SHA

**JSON Fields (queryable via `| json`):**

- `reqId` - Request ID for tracing
- `userId` - User identifier
- `billingAccountId` - Billing account
- `level` - trace | debug | info | warn | error
- `msg` - Log message
- `time` - ISO8601 timestamp
- `event` - Domain event (e.g., "ai.llm_call", "payments.intent_created")
- `durationMs` - Request/operation duration
- `errorCode` - Stable error identifier

## 3. Collect Relevant Logs

### Anti-pattern: chasing the symptom keyword

When the user reports a downstream symptom (a webhook never fires, a job never starts, a comment never posts), do **NOT** filter your first query to that symptom keyword (`webhook`, `review.routed`, `dispatchPrReview`). The pod that should emit that event may not be running at all. A symptom-keyword filter on a dead pod returns silence — and silence misleads. **Look up the call chain first**, then narrow.

**Top-down order — always:**

1. **Is the pod even running?** Pull pod-level startup logs from the env, no symptom filter:

   ```
   {namespace="cogni-<env>", pod=~"<service>-.*"} |~ "Error|Invalid|EnvValidation|panic|unhandled|started|ready"
   ```

   Look for `EnvValidationError`, `ImagePullBackOff`, init-container failures, or absence of `app started`. If the pod is crash-looping, the symptom never fires because no one is listening.

2. **Is the right SHA serving?** Compare deployed `/version.buildSha` against the source-sha map. If they don't match, the rolling deploy stalled and you're investigating the wrong code.

3. **Only then** filter to the symptom-specific events:
   ```
   {service="app", env="<env>"} | json | event="<feature>"
   ```

**For errors:**

```
{service="app", env="<env>"} | json | level="error"
{service="app", env="<env>"} |~ "(?i)(error|exception|failed)"
```

**For specific request:**

```
{service="app", env="<env>"} | json | reqId="<id>"
```

**For domain events:**

```
{service="app", env="<env>"} | json | event="payments.intent_created"
```

### Recipe: deploy/rollout failure (CI says "stale ReplicaSet still present")

If `wait-for-argocd.sh` failed in CI but didn't dump pod diagnostics (older runs predating the script's diagnostics block), reproduce them via Loki:

```
# 1. Find the newest pod created during the failing deploy window
{namespace="cogni-<env>", container="migrate"} | json
# 2. Pull that pod's app-container stderr — env validation + startup crashes land here
{namespace="cogni-<env>", pod="<pod-from-step-1>", container="app", stream="stderr"}
```

If the app stderr shows `EnvValidationError`, the secret value is wrong/missing in that env — a recent secret-wiring PR (e.g. `cc328b478` for TAVILY) likely added validation that an existing prod secret no longer satisfies.

**Time range:** Default 1 hour. Use `startRfc3339`/`endRfc3339` for custom ranges.

## 4. Synthesize and Analyze

After collecting logs, provide:

1. **Key Errors:** Distinct error messages/codes with occurrence counts
2. **Root Cause Hypotheses:** Ranked by likelihood based on log evidence
3. **Affected Scope:** Time range, request count, user impact
4. **Pattern Analysis:** Common error patterns, timing issues, request flow problems
5. **Next Steps:** Investigation recommendations or reproduction steps

## UI Access (Optional)

- Local: http://localhost:3001
- Cloud: https://<your-org>.grafana.net
