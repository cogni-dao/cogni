---
name: cicd-secrets-expert
description: "Secrets architecture reference for node-template — when to use OpenBao+ESO vs GitHub env secrets, which operation pattern fits which write/rotate/add flow, the load-bearing invariants from the spec, the YAML catalog + Zod-loader the script consumes, and where to find the canonical implementation. Use when adding/rotating a secret, designing a service that consumes secrets, debugging an ExternalSecret or writer-role login, deciding between substrate and Compose-infra routing, touching `pnpm secrets:set` / `scripts/secrets/` / `scripts/lib/secrets-catalog-loader.ts` / `nodes/<node>/.cogni/secrets-catalog.yaml` / `infra/secrets-catalog.yaml` / `infra/k8s/argocd/{openbao,external-secrets}/` / per-node ExternalSecret manifests, or evaluating any new workflow that touches secret values. Triggers: 'add a secret', 'add a node secret', 'rotate a key', 'OpenBao', 'ESO', 'ExternalSecret', 'secrets-catalog', 'catalog tier', 'A1', 'A2', 'B-tier', 'writer role', 'bao login', 'vault-action', 'vault-config-operator', 'secrets-manage', 'secret in GH env vs OpenBao', 'where do I put this credential', 'per-node catalog'."
---

# CI/CD Secrets Expert

One-page reference for anyone touching secrets in node-template. Read this BEFORE the spec; this points at what to actually read.

## North star

[`proj.agentic-fork-bootstrap`](../../../work/projects/proj.agentic-fork-bootstrap.md) — easy-start guide for a forking dev that uses OpenBao. Every PR is measured against the **forker's manual-command count**. If your change adds a manual step to `fork-quickstart.md`, that's debt — try a workflow first.

## Load-bearing invariants — gate every secrets decision

From [`docs/spec/secrets-management.md`](../../../docs/spec/secrets-management.md):

| #   | Rule                                                                                           | Where it bites                                                |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | PATH = `cogni/<env>/<service>/<KEY>`; `<service>` = catalog name                               | New service → new ExternalSecret dir                          |
| 2   | ONE ExternalSecret per (service, env) with `dataFrom: extract`; target `<service>-env-secrets` | Adding keys = NO YAML edit                                    |
| 3   | Pod `envFrom: secretRef: name: <service>-env-secrets` once per container                       | Pod spec set ONCE at service creation                         |
| 4   | NO secret value in git — ever                                                                  | Base64-in-YAML = immediate rotate + audit                     |
| 5   | OpenBao is SSOT; no parallel store (except Compose-infra `.env`, see routing)                  | Don't seed values in two places                               |
| 6   | RBAC via path policy (`eso-reader`, `<env>-writer`) bound to k8s SAs                           | Phase 5b.3 + 5b.4 of `provision-env-vm.sh`                    |
| 8   | Every access audited via OpenBao audit device → Loki                                           | Pipeline not built yet — bug.0445 follow-up                   |
| 9   | Three entry points only: CLI / workflow_dispatch / operator-MCP. Never raw `bao kv put`        | See decision tree below                                       |
| 13  | NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP — bootstrap window only; day-2 uses writer-role JWT           | `.local/<env>-openbao-root-token` is never read post-Phase-5b |

## Decision tree — where does the value live?

| Tier | Consumed by                                                              | Path                                                           | Source of truth        |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------- |
| A1   | k8s pod baseline (anything under `nodes/<n>/app/`, every fork)           | OpenBao `cogni/<env>/<service>/*` → ESO → k8s Secret → envFrom | OpenBao                |
| A2   | k8s pod node-specific (downstream node like `poly`)                      | OpenBao `cogni/<env>/<node>/*` → ESO → k8s Secret → envFrom    | OpenBao                |
| B    | Compose-infra service (postgres, litellm, temporal, redis, alloy, caddy) | GH Env Secret → `deploy-infra.sh` → `.env` on VM               | GH Environment Secrets |
| D    | CI-only (workflow consumption, never runtime)                            | GH Env Secret → workflow `env:` block                          | GH Environment Secrets |
| E    | Repo-level CI (cross-env, one value per repo)                            | GH Repo Secret                                                 | GH Repo Secrets        |
| F    | Local dev only                                                           | `.env.local` (gitignored)                                      | Operator's laptop      |
| G    | Derived from repo state at provision time (e.g. `nodes/*` listing)       | Computed by loader; written alongside other catalog values     | Auto-generated         |

Full tier definitions + invariants: [`docs/spec/secrets-classification.md`](../../../docs/spec/secrets-classification.md).
Layer-cake framing (Identity → AuthN → AuthZ → Secrets → DAO → Operator): [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md).
Routing checklist (file-by-file propagation): [`.claude/commands/env-update.md`](../../commands/env-update.md) §0.5.

## Decision tree — how do I write / rotate the value?

| Operation                                             | Right pattern                                                                                                      | Today's reality                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Add new secret SHAPE (service X consumes key A)       | PR → `vault-config-operator` CRD → Argo reconciles                                                                 | Not built; tracked in `proj.agentic-fork-bootstrap` Walk                                                                   |
| Rotate AUTO-GENERATED value (e.g., `AUTH_SECRET`)     | `rotate-secret.yml` workflow with env-protection; auto-generates value; **human approves event, never sees value** | Not built; do manual `openssl rand` + `pnpm secrets:set` per [`secrets-rotate.md`](../../../docs/guides/secrets-rotate.md) |
| Rotate VENDOR-MINTED value (OpenAI key, Cherry token) | Operator-app UI (in `cogni` repo, not node-template)                                                               | Today: CLI on candidate-a; preview/prod TBD                                                                                |
| Candidate-a experimentation                           | `pnpm secrets:set <env> <service> <KEY>` via port-forward + writer-role JWT                                        | Shipped — see [`secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                              |
| Dynamic DB credentials                                | OpenBao DB engine, no human in loop                                                                                | Future (Crawl row 3 of `proj.security-hardening`)                                                                          |

The killer rule: **no human types a secret VALUE into a UI in production.** Auto-generated, vendor-minted via operator-app, or dynamic. Form-input is the anti-pattern.

## Anti-patterns — instant reject

- Human typing a secret VALUE into a UI (GitHub form, web form, shell prompt). See killer rule.
- Generic catch-all workflow (`secrets-manage.yml`-shaped). Per-operation only.
- `ssh root@vm kubectl ...` or `ssh root@vm bao ...`. Use local kubectl + port-forward + writer-role JWT.
- Re-exporting `.local/<env>-openbao-root-token` after Phase 5b — violates Invariant 13.
- `bao kv put` instead of `bao kv patch` (replaces sibling keys).
- `bao login -method=kubernetes` in OpenBao CLI 2.5.x — that subcommand doesn't exist; use raw API: `bao write auth/kubernetes/login role=X jwt=Y`.
- Per-secret ExternalSecret YAML — violates Invariant 2.
- `valueFrom: secretKeyRef` per env var in pod spec — violates Invariant 3.
- Base64-in-git "encryption" — violates Invariant 4.
- Sealed Secrets / SOPS+ksops — explicitly rejected per `proj.security-hardening` Design Notes.
- Editing `scripts/setup-secrets.ts` to add/remove a SECRETS array entry — there isn't one. The script loads YAML via `scripts/lib/secrets-catalog-loader.ts`. Edit the appropriate `secrets-catalog.yaml` instead.
- ExternalSecret manifests under `infra/k8s/secrets/external-secrets/<env>/<node>/` for node-template — they moved to `nodes/node-template/k8s/external-secrets/<env>/` (node-domain). The aggregator references the node-tree path.

## The catalog (per-node YAML + Zod loader)

`scripts/setup-secrets.ts` does NOT hold a hardcoded SECRETS array. It calls a Zod-validated loader that walks YAML catalogs:

| File                                       | Domain                                                                             | Holds                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `nodes/<node>/.cogni/secrets-catalog.yaml` | **node-domain** (single-node-scope: poly engineer can add a poly secret in ONE PR) | A1/A2 entries the node owns; `service:` auto-fills from parent dir         |
| `infra/secrets-catalog.yaml`               | **operator-domain**                                                                | `_shared`, `_system`, B/D/E/G entries + A2 placeholders for unported nodes |
| `scripts/lib/secrets-catalog-loader.ts`    | **operator-domain (substrate)**                                                    | Zod schema + walker + uniqueness + service-allowlist assertions            |

**To add a secret to your node:** edit `nodes/<your-node>/.cogni/secrets-catalog.yaml`. One PR, your node domain. Don't touch operator-domain files.
**To add an operator-domain secret (B/D/E/G, or `_shared` cross-cutting):** edit `infra/secrets-catalog.yaml`. Operator-domain PR.
**The loader rejects at module load:** missing `tier`, name collision across files, per-node `service:` mismatch with parent dir, unknown `service:` value not in the allowlist (`_shared`/`_system` + present nodes + canonical-future-domain names from `node-ci-cd-contract.md`).

## Files to read by topic

| If you're doing…                              | Read                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understanding the tier system + invariants    | [`docs/spec/secrets-classification.md`](../../../docs/spec/secrets-classification.md)                                                                                  |
| The layered authority model (Identity → DAO)  | [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md)                                                                                  |
| Adding a new secret to your node              | Edit `nodes/<node>/.cogni/secrets-catalog.yaml` + read [`docs/guides/secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                     |
| Adding a `_shared` / B / D / E / G secret     | Edit `infra/secrets-catalog.yaml`                                                                                                                                      |
| Rotating an existing secret                   | [`docs/guides/secrets-rotate.md`](../../../docs/guides/secrets-rotate.md)                                                                                              |
| Following the bootstrap flow                  | [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md)                                                                                        |
| Adding a new service (new k8s Deployment)     | [`docs/guides/node-formation-guide.md`](../../../docs/guides/node-formation-guide.md) + add ExternalSecret under `nodes/<node>/k8s/external-secrets/<env>/`            |
| Touching substrate provisioning               | [`scripts/setup/provision-env-vm.sh`](../../../scripts/setup/provision-env-vm.sh) Phases 5b.1–5b.5                                                                     |
| Touching the CLI                              | [`scripts/secrets/set-secret.sh`](../../../scripts/secrets/set-secret.sh) + test [`scripts/ci/tests/set-secret.test.sh`](../../../scripts/ci/tests/set-secret.test.sh) |
| Touching the loader / catalog schema          | [`scripts/lib/secrets-catalog-loader.ts`](../../../scripts/lib/secrets-catalog-loader.ts) (Zod schema + walker)                                                        |
| Touching node-template's ExternalSecret       | `nodes/node-template/k8s/external-secrets/<env>/` (per-node, node-domain). Aggregator at `infra/k8s/secrets/external-secrets/<env>/kustomization.yaml`                 |
| Touching substrate Argo Applications          | `infra/k8s/argocd/{openbao,external-secrets}-application.yaml`                                                                                                         |
| Touching the env-var classification routing   | [`.claude/commands/env-update.md`](../../commands/env-update.md) — k8s app vs Compose-infra split                                                                      |
| Designing a new workflow that handles secrets | This file + `proj.agentic-fork-bootstrap` anti-patterns. Run it past the killer rule.                                                                                  |

## When to escalate

Surface to operator before writing code if:

- Adding a NEW entry point that isn't already CLI / workflow_dispatch / operator-MCP — Invariant 9 lists the only three sanctioned shapes.
- Changing `eso-reader` policy or `<env>-writer` role binding — affects every consumer.
- Bumping OpenBao or ESO chart version — rotation drill required (see `secrets-rotate.md` §Upgrade discipline).
- Anything that smells like Invariant 4 (NO_VALUE_IN_GIT) — finding a value in YAML / commit message / PR diff / chat is always a rotate-now event.
- Designing a workflow where humans type values into a form — recheck against the killer rule before building.
