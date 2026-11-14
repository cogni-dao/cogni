# runbooks · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Operational procedures and documentation for deployment, rollback, and incident response.

## Pointers

- [dolthub-remote-bootstrap.md](dolthub-remote-bootstrap.md): offline recovery, restore the Dolt knowledge hub when the hub is unreachable (the only runbook kept in the repo; online detail is [dolthub-mirror-bootstrap](https://cognidao.org/knowledge/dolthub-mirror-bootstrap))
- [grafana-postgres-readonly](https://cognidao.org/knowledge/grafana-postgres-readonly): Grafana Cloud Postgres datasource + read-only role procedure
- [worker-custodied-routing](https://cognidao.org/knowledge/worker-custodied-routing): Fixed service routing publication, receipt rollback and proof gates
- [eso-secret-sync-gate](https://cognidao.org/knowledge/eso-secret-sync-gate): Production operator OpenBao/ESO cutover and custody checks
- [CI/CD](https://cognidao.org/knowledge/operator-pipeline-contract): Branch model, workflows, deployment automation

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none
- **Files considered API:** `*.md` runbook documents

## Responsibilities

- This directory **does**: Document operational procedures and incident response
- This directory **does not**: Contain executable scripts or configurations

## Usage

Minimal local commands:

```bash
# Reference only - no executable commands
```

## Standards

- Step-by-step procedures with clear prerequisites
- Include troubleshooting sections for common issues
- Reference specific commands and environment variables

## Change Protocol

- Update this file when **new runbooks** are added
- Bump **Last reviewed** date
- Update runbooks when deployment procedures change

## Notes

- Documentation only - executable scripts belong in ../ci/scripts/
- Procedures should be tested and validated with actual deployments
