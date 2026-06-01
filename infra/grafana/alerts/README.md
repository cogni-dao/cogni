# Grafana Alerting

Grafana Git Sync does not currently sync alerting resources. Source-of-truth lives here and is applied via `scripts/grafana-apply-alert-rules.sh`, which drives Grafana's HTTP provisioning API (`/api/v1/provisioning/{contact-points,policies,alert-rules}`) idempotently — every run ends with PUT-by-UID.

## Layout

```text
infra/grafana/alerts/
├── contact-points/                              # email, Slack, webhook receivers
│   └── derek-email.json                         # email — address from $GRAFANA_ALERTS_EMAIL at apply time
├── notification-policies/
│   └── root.json                                # default route → derek-email
└── rules/
    └── postgres-datasource-health.template.json # rendered per (env, node) by the apply script
```

## Apply

CI does this automatically on `push` to `main` under `infra/grafana/alerts/**` via `.github/workflows/grafana-alerts.yml`. Manual:

```bash
GRAFANA_URL=https://<org>.grafana.net \
GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_... \
GRAFANA_ALERTS_EMAIL=you@example.com \
bash scripts/grafana-apply-alert-rules.sh
```

## Required secrets

Set per GitHub environment (`candidate-a`, `preview`, `production` — alerts are org-global, any one is sufficient to apply):

- `GRAFANA_URL` — already used by datasource provisioning.
- `GRAFANA_SERVICE_ACCOUNT_TOKEN` — `glsa_…`, Editor / Admin.
- `GRAFANA_ALERTS_EMAIL` — recipient address for `derek-email` contact point. **New for Layer 3.** Not committed; substituted into `contact-points/derek-email.json` at apply time.

## Layer 3 contract

This directory is Layer 3 of the three-layer datasource-health contract documented in `../AGENTS.md`. Don't re-couple it to Layer 1 (provisioning) or Layer 2 (verify); persistent datasource health belongs here, not in the deploy pipeline.

## Don't commit

- contact-point email addresses, Slack webhook URLs, PagerDuty integration keys
- decrypted exports from the Grafana UI

Use env-substitution at apply time (see `derek-email.json`).
