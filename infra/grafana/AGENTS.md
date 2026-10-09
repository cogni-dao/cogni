# grafana · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Grafana Cloud observability resources managed from git. This directory owns dashboard JSON synced by Grafana Git Sync and alerting resources provisioned as code.

## Pointers

- [README.md](README.md): Layout, ownership, and Git Sync setup notes
- [dashboards/](dashboards/): Dashboard JSON files synced to Grafana Cloud
- [alerts/](alerts/): Grafana-managed alerting resources; not supported by Git Sync yet
- [Observability spec](../../docs/spec/observability.md): Logging, metrics, labels, and query contracts

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none (declarative resources only)
- **Routes (if any):** none
- **Env/Config keys:** none — datasource secrets and Grafana API tokens live in CI/runtime env, not in this directory.
- **Files considered API:** `dashboards/**/*.json` (Grafana Git Sync target), `alerts/**` (Grafana-managed alerting resources)

## Responsibilities

- This directory **does**: Define Grafana dashboards, alert rule source files, and alert routing/contact-point code.
- This directory **does not**: Define app metrics, event names, or datasource secrets.

## Standards

- Dashboards live under `dashboards/` and must be valid Grafana dashboard JSON.
- Dashboard JSON should use datasource UIDs, not environment-specific URLs or credentials.
- Shared/operator dashboards stay under `dashboards/operator/`; node-specific dashboards stay under `dashboards/nodes/<node>/`.
- Alerting code stays under `alerts/` because Grafana Git Sync currently supports dashboards and folders only.
- Keep query labels aligned with `docs/spec/observability.md`: `app`, `env`, `service`, and Prometheus `node_id`.

## Change Protocol

- Update `README.md` when adding a new synced path, alerting provisioning method, or dashboard ownership rule.
- Test dashboard JSON locally with the dev Grafana stack before promoting to Grafana Cloud.

## Notes

- Scaffolding only at present — `dashboards/{operator,nodes}/` are placeholder dirs. The first real dashboards land in a follow-up.
- Grafana Git Sync does not yet support alerting resources; `alerts/README.md` documents the manual provisioning path until upstream support exists.

## Datasource provisioning vs. verification (do not re-couple)

`scripts/ci/provision-grafana-postgres-datasources.sh` only declares datasource state via the Grafana API. It MUST NOT issue runtime queries to assert connectivity. A fresh `POST /api/datasources` for a Postgres datasource has been observed to leave Grafana's per-UID query path with a stuck/bad decrypted password until a follow-up `PUT` forces re-decrypt; provisioning therefore always finishes with a `PUT` (cache-bust) regardless of whether the resource was just created or already existed. Connectivity is asserted separately by `scripts/ci/verify-grafana-postgres-datasources.sh` (bounded retry, non-blocking via `continue-on-error: true`). Persistent datasource health belongs in Grafana-native alert rules, not in the deploy pipeline.

The contract:

| Layer                                               | Script / surface                            | Blocking?                                                                  |
| --------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Provision (declarative state)                       | `provision-grafana-postgres-datasources.sh` | Yes — fails the deploy if the API write fails                              |
| Verify (post-deploy connectivity smoke, with retry) | `verify-grafana-postgres-datasources.sh`    | No — `continue-on-error: true`; failures emit `::warning::` + step summary |
| Liveness (steady-state runtime health)              | Grafana alert rules under `alerts/` (TODO)  | Pages on sustained failure                                                 |

If you ever want to add "validate" back into the provision script, don't. Extend the verify layer instead.

### Declaring state means declaring the WHOLE set (bug.5117)

Provisioning converges: it creates/updates the catalog-derived datasources **and deletes every `cogni-<env>-*-postgres` datasource that is not in that set**. Declaring state is not enough if the declared set is only a subset — a create/update loop lets a datasource outlive the node it described, keeping whatever readonly-password epoch it was born with and retrying forever on Grafana's own health schedule. Measured 2026-10-08: 55 live datasources against a derived set of 21, and ~420 `FATAL: password authentication failed for user "app_readonly"` per hour on the production Postgres, every one from a datasource outside the roster.

Rules for that prune:

- Scope is `cogni-<the env being provisioned>-<node>-postgres` and `grafana-postgresql-datasource` only. Never another environment, never Loki/Prometheus. An over-broad delete is far worse than the bug.
- An empty catalog-derived set **aborts** rather than pruning; otherwise a catalog read failure would delete the whole environment.
- `GRAFANA_DATASOURCE_PRUNE=0` logs what it would delete and deletes nothing.
- The prune is a delete-by-uid API call, not a runtime query, so it does not re-couple provision to connectivity.

Verification keys on the datasource's own error, not the HTTP status: Grafana returns `results.<refId>.error` (e.g. SQLSTATE 28P01) inside a 200 envelope, and keying on the status code alone reported credential drift as verified.

`tests/ci-invariants/grafana-datasource-convergence.spec.ts` pins all of the above by running the real scripts against a PATH-injected `curl` shim.
