# Grafana as Code

Grafana-owned observability resources live here because they are infrastructure/operator assets, not node app code. Node apps emit logs and metrics; Grafana turns those signals into operational views and alerts.

## Layout

```text
infra/grafana/
├── cloud-bootstrap/  # OpenTofu derives scoped Grafana + Synthetic Monitoring credentials
├── dashboards/
│   ├── operator/       # cross-node, deployment, platform, and agent-loop dashboards
│   └── nodes/<node>/   # node-specific dashboards such as poly or resy
├── alerts/             # Grafana-managed alerting resources, provisioned outside Git Sync
└── synthetic/          # catalog-derived checks, alert groups, and public status share
```

## Git Sync

Configure the Grafana Git Sync repository resource to this repo, target branch `main`, and path:

```text
infra/grafana/dashboards/
```

Grafana Git Sync currently synchronizes dashboards and folders only. Alerts, data sources, and other resources are not supported by Git Sync, so alerting definitions belong in `infra/grafana/alerts/` and should be applied with Terraform/OpenTofu or Grafana's alerting provisioning API.

## Fleet reliability reconcile

The reviewed [fleet reliability guide](https://cognidao.org/knowledge/fleet-reliability-reconcile-guide) is canonical. Reconcile `cloud-bootstrap/` before `synthetic/`; both use mode-0600, gitignored local state. Grafana remains the durable runtime authority, so state loss cannot interrupt live checks or alerts and must be recovered by adopting stable resource identities before planning.

This reconcile is operator-substrate administration, not a node-developer
workflow and not part of environment provisioning. It runs only when an
operator explicitly invokes OpenTofu with operator-only bootstrap inputs.
Tenant URLs, stack identifiers, and credentials belong in private operator
configuration; never add them to this directory or node-facing guidance.

Fleet alert delivery is query-only. OpenTofu owns an all-time mute timing,
applies it both to the global notification tree and directly to every fleet
rule, and preserves rule evaluation plus Grafana alert history. The required
structural receiver has no human address, uses a reserved `.invalid` target,
and is never invoked while muted. Direct Grafana reads are operator-substrate
access only. Node developers never receive its service-account token: they use
their Cogni API key plus the node's OpenFGA `developer` grant through
node-scoped operator proxies (the logs proxy is live; the equivalent health
proxy is the next product surface). No email, webhook, chat, or page is
delivered.

## Ownership

- Use `dashboards/operator/` for platform-wide dashboards: deploy health, candidate validation, all-node RED/USE views, Loki validation coverage, and Grafana Cloud spend.
- Use `dashboards/nodes/<node>/` only when the dashboard is meaningful for one node's domain and should not be mixed with platform/operator views.
- Do not place Grafana resources under `nodes/operator/`; that app is a product surface, while these files configure external observability.
- Do not place Cloud Git Sync dashboards under `infra/compose/runtime/configs/grafana-provisioning/`; that directory is local Grafana provisioning for the dev stack.

## Local Preview

The local dev Grafana container provisions dashboards from `infra/grafana/dashboards/` at startup. Start it with:

```bash
pnpm dev:infra
```

Then open `http://localhost:3001`.
