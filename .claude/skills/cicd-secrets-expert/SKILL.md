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

## Runtime env triage

`serverEnv()` validates process env; it does not decide the source of truth.
Classify first:

- **Secret:** leaking it requires rotation or incident response. Route through
  OpenBao/ESO or the proper GH secret tier.
- **Plain config:** owner slugs, repo names, public URLs, feature modes, and
  routing values. Route through GitOps ConfigMaps or repo config.

For either path, k8s object presence is not process proof. Pods read env only at
startup, so prove: source object -> Deployment `envFrom` -> restarted pod env ->
public health. Treat old Argo/workflow failures as leads until live cluster
checks agree.

## App flight substrate assertions are read-only

`candidate-flight.yml` uses `scripts/ci/assert-target-substrate.sh` as a
preflight for selected app rollouts. That gate may verify a Deployment-consumed
k8s Secret exists and its matching ExternalSecret is Ready, but it must not seed
OpenBao, patch GitHub secrets, run `deploy-infra.sh`, or repair Compose/env
state. A missing secret is a substrate failure: use `pnpm secrets:set`, the
env-provisioning lane, or the explicit infra flight that owns the mutation.

The target shape matters. Today the implemented branch is `type=node`; a future
`type=service` branch should assert the service's declared Secret /
ExternalSecret / ConfigMap contract without inheriting node DNS, Caddy, NodePort,
or node-DB assumptions.

## Decision tree — how do I write / rotate the value?

| Operation                                             | Right pattern                                                                                                      | Today's reality                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Add new secret SHAPE (service X consumes key A)       | PR → `vault-config-operator` CRD → Argo reconciles                                                                 | Not built; tracked in `proj.agentic-fork-bootstrap` Walk                                                                   |
| Rotate AUTO-GENERATED value (e.g., `AUTH_SECRET`)     | `rotate-secret.yml` workflow with env-protection; auto-generates value; **human approves event, never sees value** | Not built; do manual `openssl rand` + `pnpm secrets:set` per [`secrets-rotate.md`](../../../docs/guides/secrets-rotate.md) |
| Rotate VENDOR-MINTED value (OpenAI key, Cherry token) | Operator-app UI (in `cogni` repo, not node-template)                                                               | Today: CLI on candidate-a; preview/prod TBD                                                                                |
| Candidate-a experimentation                           | `pnpm secrets:set <env> <service> <KEY>` via port-forward + writer-role JWT                                        | Shipped — see [`secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                              |
| Dynamic DB credentials                                | OpenBao DB engine, no human in loop                                                                                | Future (Crawl row 3 of `proj.security-hardening`)                                                                          |

The killer rule: **no human types a secret VALUE into a UI in production.** Auto-generated, vendor-minted via operator-app, or dynamic. Form-input is the anti-pattern.

## Dual-plane secrets — the silent-webhook-fail class (READ THIS)

Some secrets must **byte-equal a value held by an external system**, not merely exist. The operator's `GH_WEBHOOK_SECRET` must equal the **GitHub App's webhook secret**; an OAuth `*_CLIENT_SECRET` must equal the provider's app config. These are **dual-plane**: one copy in our pod, one on the external plane — they only work if identical.

**The trap (live bug, preview 2026-06-03):** `GH_WEBHOOK_SECRET` was `source: agent` with **no `syncTo`**, generated `randHex 32` **every provision** → it could never match the App's webhook secret → **every webhook failed HMAC verification**, silently (a `level:40` warn `component:webhook-route msg:"webhook verification failed"`, no alert, no 5xx). The App just looks dead — no PR reviews, no node-wizard. `deploy-infra` re-applying the Secret was the **breaking** path, not the healing one — a generated value never equals an externally-held one **unless something pushes it there**. That push is what `syncTo` declares.

**The classification has TWO orthogonal axes — don't conflate them.** `source:` = origin; `syncTo:` = external mirror.

| axis              | values                                                                                                                                              | answers                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `source:`         | `agent` (we generate, `generate:` required) · `human` (un-generatable; vendor-minted, human supplies once, e.g. `GH_REVIEW_APP_PRIVATE_KEY_BASE64`) | where the value **originates**                                       |
| `syncTo:` _(opt)_ | `github-app-webhook` · _(unset)_                                                                                                                    | does it **also** live in an external system we must keep in lockstep |

`GH_WEBHOOK_SECRET` is `source: agent` + `syncTo: github-app-webhook` — **we generate it** (origin is internal; calling it `source: external` lied about that), and it ALSO must byte-match the App. `bootstrap.sh::declare_or_gen` generates it; `deploy-infra` then pushes it (`scripts/secrets/sync-app-webhook-secret.sh`: App JWT → `PATCH /app/hook/config`):

```
APPID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 → RS256 JWT (iss=APPID, exp≤10m)
PATCH /app/hook/config  -d '{"secret":"<generated GH_WEBHOOK_SECRET>"}'   # endpoint EXISTS
```

No-human-secret done right: agent generates, agent pushes, **zero human, self-healing** (provisioning owns both copies → every infra-lever deploy re-converges). Do NOT make it `source: human`/carry — that drags a human into the App's "Change secret" field for a value that's ours to generate.

⚠️ **Sync only fires on the infra lever** (`deploy-infra` via `candidate-flight-infra` / `provision-env`), NOT on app-lever promotes (`candidate-flight`/`flight-preview`/`promote-and-deploy` = Argo image bump, never touches the Secret). `assert-target-substrate.sh` is also read-only: it can fail a flight when the Deployment-consumed Secret / ExternalSecret is absent or not Ready, but it does not heal the value. And the push uses deploy-infra's env value — correct for the plain-Secret model (preview/prod) but on the **ESO model (candidate-a)** the pod serves OpenBao's value; if those differ the sync must read the live Secret. (candidate-a live-read = tracked follow-up.)

**Heal-proof test** = redeploy twice; a PR on the test repo must still post a `cogni-git-review` review.

## Anti-patterns — instant reject

- Human typing a secret VALUE into a UI (GitHub form, web form, shell prompt). See killer rule.
- A **dual-plane** secret (must byte-match an external system — GitHub App webhook secret, OAuth client secret) declared with **no `syncTo:`** — it silently fails verification forever and `deploy-infra` re-breaks it every run. Add `syncTo:` (keep `source: agent` if we generate the value). See "Dual-plane secrets" above.
- Generic catch-all workflow (`secrets-manage.yml`-shaped). Per-operation only.
- `ssh root@vm kubectl ...` or `ssh root@vm bao ...`. Use local kubectl + port-forward + writer-role JWT.
- Treating k8s Secret or ConfigMap presence as proof that a running pod has the value. Prove the process after rollout.
- Treating a failed app-flight substrate assertion as permission to run
  `deploy-infra` from the app flight. Heal secrets/substrate through the owning
  secrets or infra lane; keep app flight read-only until image promotion.
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

| If you're doing…                                | Read                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understanding the tier system + invariants      | [`docs/spec/secrets-classification.md`](../../../docs/spec/secrets-classification.md)                                                                                                                                                                                                                                                                                                              |
| The layered authority model (Identity → DAO)    | [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md)                                                                                                                                                                                                                                                                                                              |
| Adding a new secret to your node                | Edit `nodes/<node>/.cogni/secrets-catalog.yaml` + read [`docs/guides/secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                                                                                                                                                                                                                                                 |
| Adding a `_shared` / B / D / E / G secret       | Edit `infra/secrets-catalog.yaml`                                                                                                                                                                                                                                                                                                                                                                  |
| Rotating an existing secret                     | [`docs/guides/secrets-rotate.md`](../../../docs/guides/secrets-rotate.md)                                                                                                                                                                                                                                                                                                                          |
| Following the bootstrap flow                    | [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md)                                                                                                                                                                                                                                                                                                                    |
| **Provisioning a new env** (candidate-\*, fork) | Dispatch [`.github/workflows/provision-env.yml`](../../../.github/workflows/provision-env.yml) (`-f env=<env> -f encryption_passphrase=…`). Full walkthrough — 7 minting secrets + init-artifact custody — in [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md) §6. The runner owns the tofu+bao+kubectl session; the operator's laptop never holds substrate creds. |
| Adding a new service (new k8s Deployment)       | [`docs/guides/node-formation-guide.md`](../../../docs/guides/node-formation-guide.md) + add ExternalSecret under `nodes/<node>/k8s/external-secrets/<env>/`                                                                                                                                                                                                                                        |
| Touching substrate provisioning                 | [`scripts/setup/provision-env-vm.sh`](../../../scripts/setup/provision-env-vm.sh) Phases 5b.1–5b.5                                                                                                                                                                                                                                                                                                 |
| Touching the CLI                                | [`scripts/secrets/set-secret.sh`](../../../scripts/secrets/set-secret.sh) + test [`scripts/ci/tests/set-secret.test.sh`](../../../scripts/ci/tests/set-secret.test.sh)                                                                                                                                                                                                                             |
| Touching the loader / catalog schema            | [`scripts/lib/secrets-catalog-loader.ts`](../../../scripts/lib/secrets-catalog-loader.ts) (Zod schema + walker)                                                                                                                                                                                                                                                                                    |
| Touching node-template's ExternalSecret         | `nodes/node-template/k8s/external-secrets/<env>/` (per-node, node-domain). Aggregator at `infra/k8s/secrets/external-secrets/<env>/kustomization.yaml`                                                                                                                                                                                                                                             |
| Touching substrate Argo Applications            | `infra/k8s/argocd/{openbao,external-secrets}-application.yaml`                                                                                                                                                                                                                                                                                                                                     |
| Touching the env-var classification routing     | [`.claude/commands/env-update.md`](../../commands/env-update.md) — k8s app vs Compose-infra split                                                                                                                                                                                                                                                                                                  |
| Designing a new workflow that handles secrets   | This file + `proj.agentic-fork-bootstrap` anti-patterns. Run it past the killer rule.                                                                                                                                                                                                                                                                                                              |

## When to escalate

Surface to operator before writing code if:

- Adding a NEW entry point that isn't already CLI / workflow_dispatch / operator-MCP — Invariant 9 lists the only three sanctioned shapes.
- Changing `eso-reader` policy or `<env>-writer` role binding — affects every consumer.
- Bumping OpenBao or ESO chart version — rotation drill required (see `secrets-rotate.md` §Upgrade discipline).
- Anything that smells like Invariant 4 (NO_VALUE_IN_GIT) — finding a value in YAML / commit message / PR diff / chat is always a rotate-now event.
- Designing a workflow where humans type values into a form — recheck against the killer rule before building.
