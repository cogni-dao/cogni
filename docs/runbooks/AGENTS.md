# runbooks · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Operational procedures and documentation for deployment, rollback, and incident response.

## Pointers

- [INFRASTRUCTURE_SETUP.md](INFRASTRUCTURE_SETUP.md): VM provisioning, DNS, GitHub secrets (disaster recovery)
- [DEPLOYMENT_ARCHITECTURE.md](DEPLOYMENT_ARCHITECTURE.md): Architecture overview
- [grafana-postgres-readonly.md](grafana-postgres-readonly.md): Grafana Cloud Postgres datasource + read-only role procedure
- [production-operator-eso-cutover.md](production-operator-eso-cutover.md): Production operator OpenBao/ESO cutover and custody checks
- [CI/CD](../../docs/spec/ci-cd.md): Branch model, workflows, deployment automation

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
