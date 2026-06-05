---
id: eso-adoption-migration-guide
type: guide
title: ESO Adoption Migration
status: draft
trust: draft
summary: Pareto checklist for moving candidate-a, preview, production, and wizard-born nodes from deploy-infra-created app Secrets to OpenBao plus External Secrets Operator.
read_when: Migrating app pods to ESO, checking whether an env needs reprovisioning, or updating node formation so new nodes consume OpenBao-backed secrets.
owner: derekg1729
created: 2026-06-05
verified: null
tags: [secrets, openbao, eso, deployment, node-formation]
---

# ESO Adoption Migration

## Goal

Every pod-consumed A1/A2 secret follows the contract:

```
OpenBao cogni/<env>/<service>
  -> ExternalSecret dataFrom.extract
  -> k8s Secret <service>-env-secrets
  -> pod envFrom: secretRef
  -> Reloader restart on change
```

`deploy-infra.sh` should not be the steady-state writer for app pod secrets. Keep it for Compose infra, edge routing, DB creation while static DB credentials are transitional, and node-birth side effects that are not yet GitOps.

## Runtime Clarification

Same image SHA does not imply same secret path. The container code is identical across environments, but each env overlay chooses the Secret object mounted into the pod. A pod running SHA `X` can read either:

- `operator-node-app-secrets`, created imperatively by `deploy-infra.sh`, or
- `operator-env-secrets`, owned by ESO from OpenBao.

The code fallback for `NODE_SUBMODULE_PARENT_OWNER` / `NODE_SUBMODULE_PARENT_REPO` exists in every image, but `NODE_MINT_OWNER` and `NODE_TEMPLATE_OWNER` intentionally fail closed when missing. That is why the manifest wiring matters even when the app SHA is the same.

## Starting Adoption Matrix

Static repo-state snapshot before this migration began on 2026-06-05:

| Env           | ExternalSecret leaves                                             | Pod consumers on ESO                   | Legacy consumers                |
| ------------- | ----------------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| `candidate-a` | `operator`, `resy`, `scheduler-worker`, `node-template`, `canary` | `operator`, `resy`, `scheduler-worker` | `node-template`, `canary`       |
| `preview`     | none                                                              | none                                   | all node apps, scheduler-worker |
| `production`  | none                                                              | none                                   | all node apps, scheduler-worker |

`candidate-b` already has the clean shape and can be used as the manifest template.

## Reprovision Decision

Do not reprovision an env just to adopt app pods into ESO. Reprovision only if the substrate is absent or broken:

```bash
kubectl -n argocd get application openbao external-secrets reloader
kubectl get clustersecretstore openbao-backend
kubectl get crd externalsecrets.external-secrets.io clustersecretstores.external-secrets.io
```

If those exist and are healthy, the Pareto path is targeted: add/apply ExternalSecret leaves, seed OpenBao paths, and switch overlays. A full `provision-env.yml` run applies only leaves that exist in git; it cannot cut over preview/production while their leaf directories are absent.

## Pareto Checklist

### 1. Finish candidate-a

- [x] Switch `infra/k8s/overlays/candidate-a/node-template` to `node-template-env-secrets`.
- [x] Switch `infra/k8s/overlays/candidate-a/canary` to `canary-env-secrets`.
- [x] Verify `nodes/node-template/k8s/external-secrets/candidate-a` and `nodes/canary/k8s/external-secrets/candidate-a` target the same names.
- [ ] Flight candidate-a and confirm `/version.buildSha` for changed apps.
- [ ] Confirm ESO status live:

```bash
kubectl -n cogni-candidate-a get externalsecret
kubectl -n cogni-candidate-a get secret node-template-env-secrets canary-env-secrets
```

### 2. Add preview and production leaves

- [x] Add operator-domain leaves:
  - `infra/k8s/secrets/external-secrets/preview/operator`
  - `infra/k8s/secrets/external-secrets/preview/resy`
  - `infra/k8s/secrets/external-secrets/preview/scheduler-worker`
  - `infra/k8s/secrets/external-secrets/preview/node-template`
  - `infra/k8s/secrets/external-secrets/preview/canary`
  - `infra/k8s/secrets/external-secrets/production/operator`
  - `infra/k8s/secrets/external-secrets/production/resy`
  - `infra/k8s/secrets/external-secrets/production/scheduler-worker`
  - `infra/k8s/secrets/external-secrets/production/node-template`
  - `infra/k8s/secrets/external-secrets/production/canary`
- [x] Each leaf uses `dataFrom.extract.key: <env>/<service>` and target `<service>-env-secrets`, except `scheduler-worker`, whose existing pod contract is `scheduler-worker-secrets`.

### 3. Switch preview and production overlays

- [x] Replace every node app `*-node-app-secrets` ref with `*-env-secrets` in preview overlays.
- [x] Replace every node app `*-node-app-secrets` ref with `*-env-secrets` in production overlays.
- [x] Keep `scheduler-worker-secrets` unchanged; ESO can own that same Secret name.
- [x] Run `kustomize build` for every touched overlay.

### 4. Seed and sync OpenBao

- [ ] Verify each path exists:

```bash
bao kv metadata get cogni/preview/operator
bao kv metadata get cogni/production/operator
```

- [ ] For missing values, use the env writer role plus `pnpm secrets:set <env> <service> <KEY>`.
- [ ] Force-sync only when immediate validation is needed:

```bash
kubectl -n cogni-<env> annotate externalsecret <name> force-sync="$(date +%s)" --overwrite
```

### 5. Add a drift guard

- [x] CI fails if a deployed node app overlay for `candidate-a`, `preview`, or `production` references `*-node-app-secrets`.
- [x] CI fails if a node app overlay references `<service>-env-secrets` but the matching ExternalSecret leaf does not exist.
- [x] CI fails if an ExternalSecret target name and overlay Secret name diverge.
- [x] Wizard generator tests prove a new node inherits `*-env-secrets`, not the legacy bridge name.

### 6. Update node formation

- [x] Change `node-template` overlays to use `node-template-env-secrets` in all three envs.
- [x] Ensure the TS overlay generator inherits `<slug>-env-secrets` from the template overlay.
- [x] Generate ExternalSecret leaves for a new node in all active envs.
- [x] Keep excluding copied `secrets-catalog.yaml`; a fresh node declares no unique secret keys.
- [ ] On node birth, run only the side effects still outside ESO: DB creation, edge route, DNS, and optional OpenBao seed verification.

### 7. Retire the bridge

After every active env has app pods on ESO:

- [ ] Remove the per-node `kubectl create secret generic <node>-node-app-secrets` block from `deploy-infra.sh`.
- [ ] Remove `NODE_MINT_OWNER` / `NODE_TEMPLATE_OWNER` threading through deploy-infra once no pod consumes the bridge Secret.
- [ ] Keep Compose B-tier secrets in the deploy-infra path until those services move into k8s.

## Acceptance Criteria

- `kubectl -n cogni-<env> get externalsecret` shows all app/service leaves `Ready=True`.
- Every node app Deployment in `candidate-a`, `preview`, and `production` references `<node>-env-secrets`.
- `scheduler-worker` references `scheduler-worker-secrets`, and that Secret is ESO-owned.
- The wizard-created node PR contains overlays that reference `<slug>-env-secrets`.
- A candidate flight of a node-birth PR no longer needs deploy-infra for app Secret creation; any remaining infra run is for DB, edge, DNS, or other non-ESO side effects.
