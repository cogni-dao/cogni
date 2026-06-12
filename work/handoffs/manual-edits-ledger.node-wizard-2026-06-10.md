---
id: manual-edits-ledger-node-wizard-2026-06-10
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: derekg1729/node-wizard-secrets-flight
last_commit: a4b01407cf
---

# Manual Edits Ledger — candidate-a + preview (node-wizard session, 2026-06-10)

Every out-of-band VM/cluster edit made this session, so reproducibility can be
restored. **Rule: each row must end with a durable fix (git/provision), or be
reverted.** Manual cluster state is debt until the durable column lands.

Root pattern: nearly every row is a symptom of **provisioning and deploying not
being split** — substrate (DBs, roles, ExternalSecrets) and deploy state (Argo
AppSets, images) drift because they run on different triggers/cadences.

## candidate-a (`84.32.9.111`)

| #   | Edit                                                                                                                           | Why                                                                          | Durable fix                                                                                                                                  | Status                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `scp` current-`main` `provision.sh` → `/opt/cogni-template-runtime/postgres-init/provision.sh` (old backed up `.pre-1584-bak`) | VM's provisioner predated #1584 → no per-node `app_<node>` roles → oss 28P01 | `candidate-flight-infra`/`provision-env` deploys current `provision.sh`; OR `node-substrate` rsyncs it before db-provision                   | **LEFT IN PLACE** (proves #1584 Postgres fix; backup on VM)                                                                                         |
| 2   | `kubectl delete pod` stuck oss pods (×2)                                                                                       | Clear accumulated CrashLoop backoff after fix                                | none — k8s recreates                                                                                                                         | ephemeral, no revert                                                                                                                                |
| 3   | `bao kv patch cogni/candidate-a/oss DOLTGRES_URL=<live-superuser>`                                                             | Stopgap to clear oss `migrate-doltgres` 28P01                                | **NONE — this is the anti-pattern.** `DOLTGRES_URL` is `source: derived`; hand-writing it violates the catalog→materialize→OpenBao direction | ⚠️ **TECHDEBT — TO REVERT.** Superseded by the Doltgres half of #1584 (re-init env Doltgres to the derived superuser, then materialize recomposes). |

## preview (`84.32.25.59`)

| #   | Edit                                                                                                                            | Why                                                                                                               | Durable fix                                                                                                                                      | Status                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 4   | `kubectl delete externalsecret env-secrets` (cogni-preview)                                                                     | Misnamed duplicate ES collided with `operator-env-secrets` (`owned by another ExternalSecret`)                    | **Repo fix committed `a4b01407cf`** — operator preview+prod ES renamed `env-secrets`→`operator-env-secrets`                                      | repo done; cluster delete holds until provision applies the renamed manifest |
| 5   | `kubectl annotate externalsecret operator-env-secrets force-sync`                                                               | Force ESO re-sync after removing the conflict                                                                     | none                                                                                                                                             | ephemeral, no revert                                                         |
| 6   | `kubectl delete applicationset+application cogni-preview-{ayo,canary,coulditbe,creative,node-template,pandora,please,resy}` (8) | Preview provisioned `operator` only; 8 unprovisioned nodes' pods were OOM-starving the VM (~6 GB fits ~2–3 nodes) | **per-env node-set config** — deploy only the nodes an env provisioned (provisioning/deploying split). Today every env gets all-catalog AppSets. | ⚠️ **NOT DURABLE** — regenerated by `reconcile-appset` on next flight        |
| 7   | `kubectl apply` `cogni-preview-scheduler-worker` AppSet (re-create)                                                             | Corrected #6 — accidentally removed it; operator `/readyz` hard-depends on scheduler-worker `:9000`               | same as #6 (scheduler-worker must be in preview's node set)                                                                                      | restored                                                                     |
| 8   | `kubectl delete applicationset+application cogni-preview-oss`                                                                   | oss unprovisioned on preview (`CreateContainerConfigError`); not needed for operator proof                        | same as #6                                                                                                                                       | ⚠️ NOT DURABLE                                                               |

## local (`.local/`, not a VM)

| #   | Edit                                                                                                                                     | Why                                    | Status                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- |
| 9   | Decrypted preview init-artifacts (run `27259379198`) → installed fresh `preview-vm-key` + `preview-kubeconfig.yaml` (stale `.stale-bak`) | Dev's re-provision rotated the SSH key | kept (correct current creds) |

## Reproducibility gaps surfaced (the durable backlog)

1. **#1584 Doltgres half (candidate-a):** env Doltgres superuser set pre-#1584 (`b350…`); Doltgres `0.56.3` can't `ALTER` it. Fix = re-init the volume to the current derived `DOLTGRES_PASSWORD`, then materialize recomposes all `DOLTGRES_URL`s (zero hand-edits). Retires row 3.
2. **Per-env node-set (preview/prod):** deploy must ship only what an env provisioned. Retires rows 6–8.
3. **ESO ownership:** node ExternalSecrets must be Argo-managed (single owner), not applied out-of-band by provisioning — the duplicate in row 4 was un-tracked. Tied to the provisioning/deploying split.
   </content>
