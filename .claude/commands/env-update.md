---
description: Add or change an env var / secret — the catalog-SSOT self-serve path
---

You are adding or changing an environment variable. **There is exactly one edit site.** The
old multi-surface checklist (GH secrets + `deploy-infra.sh` ×3 + `setup-secrets.ts` array +
compose files + `SETUP_DESIGN.md`) is retired — those hand-maintained lists drifted, which is
the entire reason `DOLTHUB_*` sat dormant despite being declared. The catalog is now the single
source the provisioner reads. See [`docs/spec/secrets-management.md`](../../docs/spec/secrets-management.md).

## Step 0 — Secret or plain config?

|                         | Secret (a credential/token/key)           | Plain config (a non-sensitive value)         |
| ----------------------- | ----------------------------------------- | -------------------------------------------- |
| **Lives in**            | OpenBao (`cogni/<env>/<service>/<KEY>`)   | k8s ConfigMap / `node-app-config`            |
| **Declared in**         | a **secrets catalog** (below)             | the overlay ConfigMap patch + Zod env schema |
| **Reaches the pod via** | ESO → `<service>-env-secrets` → `envFrom` | ConfigMap `envFrom`                          |

If it is **plain config**, you are in the wrong guide — add it to the node overlay's
`node-app-config` patch and the Zod schema (`nodes/*/app/src/shared/env/server-env.ts`). Stop here.

If it is a **secret**, continue.

## Step 1 — Declare it in the catalog (the one edit)

Add ONE entry to the catalog that owns it:

- **Your node owns it** (e.g. a poly-only key): `nodes/<your-node>/.cogni/secrets-catalog.yaml`.
  One PR, your node domain, single-node-scope. `service:` auto-fills from the parent dir.
- **Cross-cutting** (`_shared`, `_system`, or a B/D/E/G tier): `infra/secrets-catalog.yaml`
  (operator domain).

```yaml
- name: MY_NEW_KEY
  tier: A1 # A1 pod-baseline · A2 node-specific · B Compose-infra · D/E CI-only · G derived
  appliesTo: all-nodes # capability marker: all-nodes | web | database | llm | openclaw | payments
  shared: false # false → distinct per node (cogni/<env>/<node>/*); true → cogni/<env>/_shared/*
  source: human # human (you provide the value) | agent (generated) | derived
  required: false
  category: "My Feature"
  description: One line — what consumes it and why.
  steps: ["Where to obtain the value (vendor dashboard, etc.)"]
```

The Zod loader (`scripts/lib/secrets-catalog-loader.ts`) validates this at load time: tier present,
`service:` matches the parent dir, name unique across catalogs. The provisioner derives its
fan-out **from this entry** — no second list to update.

## Step 2 — Provide the value (no laptop, no kubectl, no Derek)

The catalog entry declares that the key _exists_ and where it routes. To write its _value_:

- **`source: agent`** — nothing to do; it is generated at seed (distinct per node).
- **`source: human`** — provision the value through a sanctioned write path (spec Invariant 9):
  the `secret-set` workflow_dispatch (GH-OIDC → OpenBao; value staged as a sealed GH Environment
  Secret, never a plaintext input) for a live env, or `pnpm secrets:set <env> <service> <KEY>` for
  candidate experimentation. **The value never enters git, Actions logs, or a laptop root token.**

## Step 3 — Consume it in code

Read `process.env.MY_NEW_KEY`. Add it to the runtime Zod schema
(`nodes/*/app/src/shared/env/server-env.ts`) so a missing required key fails fast at boot
(Invariant 12 TRANSITION_SAFE). **No pod-spec edit** — `envFrom: <service>-env-secrets` is set once
at service creation; ESO syncs the new key; Stakater Reloader rolling-restarts the pod so the value
is actually read (`envFrom` is read once, at container start).

## What you do NOT touch (retired surfaces)

`deploy-infra.sh` REQUIRED_SECRETS/heredoc · `provision-env.yml` per-secret `env:` maps ·
`NODE_BASELINE_KEYS` · `SETUP_DESIGN.md` secret lists · per-key ExternalSecret YAML · pod specs.
If you find yourself editing any of these to add a secret, the catalog-SSOT wiring has regressed —
file it, do not hand-patch around it.

## Reference

- [Secrets Management spec](../../docs/spec/secrets-management.md) — the self-serve model + invariants
- [Per-Node Secrets Catalog design](../../docs/design/secrets-catalog-per-node.md) — the catalog model
- [`/cicd-secrets-expert`](../skills/cicd-secrets-expert/SKILL.md) — decision trees + file map
- [`docs/guides/secrets-add-new.md`](../../docs/guides/secrets-add-new.md) — CLI walkthrough
