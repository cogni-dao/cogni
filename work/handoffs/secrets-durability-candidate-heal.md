---
id: handoff.secrets-durability-candidate-heal
type: handoff
work_item_id: ""
status: active
created: 2026-06-13
updated: 2026-06-13
branch: "derekg1729/secrets-durability-candidate-heal"
last_commit: "pending-amend-after-639730af7efb15a0fb2e8ab57bba754c0e7ee30f"
---

# Handoff: Secrets Durability + Candidate-A Heal

## Mission

Pickup: finish proving PR #1661 and get candidate-a unblocked. The work fixes the deploy-infra/OpenBao split-brain path that can rewrite runtime secrets from stale GitHub env values, and it also clears candidate-a's stale live `operator-secrets-writer` Deployment field through git-managed desired state.

## Goal

- Runtime secrets in established ESO environments are durable across deploy-infra runs: Compose `.env`, bridge k8s Secrets, scheduler-worker ledger DB URL, and GitHub App webhook sync source from OpenBao.
- Candidate-a operator can roll again: `operator-node-app` no longer carries `serviceAccountName: operator-secrets-writer`; Argo reaches Synced/Healthy and `/version` for PR #1661.
- Validation signal: a post-unseal candidate-flight-infra succeeds, a fresh candidate-flight succeeds, and PR #1661 has a candidate scorecard / run links.

## Start By Reading

- `.claude/skills/cicd-secrets-expert/SKILL.md` — north-star contract; dual-plane webhook + anti-pattern sections are directly relevant.
- `scripts/ci/deploy-infra.sh` — OpenBao read helper and runtime SSoT branch around the `.env` render.
- `scripts/secrets/sync-app-webhook-secret.sh` — GitHub App webhook external-plane sync.
- `infra/k8s/overlays/candidate-a/operator/kustomization.yaml` — explicit `serviceAccountName: default` patch that should heal candidate-a.
- `nodes/operator/k8s/external-secrets/{preview,production}/external-secret.yaml` — ExternalSecret object names now match `operator-env-secrets`.

## Current State

- PR: https://github.com/Cogni-DAO/cogni/pull/1661 (draft)
- Branch: `derekg1729/secrets-durability-candidate-heal`
- Commit: local amend pending over `639730af7efb15a0fb2e8ab57bba754c0e7ee30f`; push before rerunning final checks.
- Failed infra flight: https://github.com/Cogni-DAO/cogni/actions/runs/27460075712. Root cause was sealed candidate-a OpenBao: deploy-infra entered OpenBao SSoT mode, then `OPENFGA_DB_PASSWORD` read empty and `db-provision` failed.
- Failed candidate flight: https://github.com/Cogni-DAO/cogni/actions/runs/27460075718. `secret-materialize` completed (`created=0 unchanged=26`), then `node-substrate` exited 137 while OpenBao restarted/resealed.
- Recovery done: candidate-a OpenBao unsealed from local init artifact without using the root token. `OPENFGA_DB_PASSWORD` already existed and was read-proofed through `candidate-a-db-reader`; no new secret value was written.
- Active post-unseal infra flight: https://github.com/Cogni-DAO/cogni/actions/runs/27460654647.
- Local validation passed after the follow-up patch: `bash -n scripts/ci/deploy-infra.sh`, `bash -n scripts/secrets/sync-app-webhook-secret.sh`, `git diff --check`, and `bash scripts/ci/tests/secrets-fanout.test.sh` (34/34).
- Live candidate-a now reports `operator-node-app.spec.template.spec.serviceAccountName=default`; the stale `operator-secrets-writer` field is healed.

## Design / Implementation Target

1. Established ESO environments must render deploy-infra runtime values from OpenBao before writing Compose `.env`, bridge Secrets, or webhook external-plane sync.
2. Fresh/plain-Secret bootstrap must still work before `operator-env-secrets` exists; only established ESO mode fails closed on missing required OpenBao values or webhook PATCH failure.
3. OpenBao sealed/unavailable must fail before Compose with a required OpenBao key message, not silently fall back to GitHub env values or overwrite fresh bootstrap env vars with empty strings.

## Next Actions / Risks

- [ ] Amend + push the local patch that makes `OPENFGA_DB_PASSWORD` and `TEMPORAL_DB_PASSWORD` required OpenBao-sourced keys only in established ESO mode.
- [ ] Watch infra run `27460654647`; if it fails, inspect `Deploy Compose infra to candidate-a VM` logs around `operator-env-secrets exists; rendering runtime secrets from OpenBao SSoT`.
- [ ] If infra succeeds, dispatch `candidate-flight.yml` for PR #1661 at the amended head SHA.
- [ ] If candidate flight succeeds, post the run links / scorecard to PR #1661 and mark ready for review.
- [ ] Check preview and production OpenBao key readiness before healing them: both were unsealed/ready at pickup time, but do not run deploy-infra there until candidate-a proves the amended path.
- Risk: candidate-a OpenBao is Shamir 1-of-1 and resealed after a restart. If it reseals again, unseal/alerting is the blocker, not missing secret values.
- Risk: `candidate-flight-infra.yml --ref HEAD` is ambiguous locally because deploy-infra resolves `origin/HEAD`; use branch name or full SHA.
- Risk: webhook sync now fails closed in OpenBao SSoT mode. A failure is a real dual-plane mismatch risk, not a warning to ignore.

## Pointers

| File / Resource                                              | Why it matters                                   |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `scripts/ci/deploy-infra.sh`                                 | OpenBao SSoT read path and bridge Secret render. |
| `scripts/secrets/sync-app-webhook-secret.sh`                 | External GitHub App webhook plane convergence.   |
| `.claude/skills/cicd-secrets-expert/SKILL.md`                | Secrets architecture contract for review.        |
| `docs/spec/secrets-management.md`                            | Spec aligned to OpenBao-render bridge behavior.  |
| `infra/k8s/overlays/candidate-a/operator/kustomization.yaml` | Candidate-a ServiceAccount stale-field fix.      |
| PR #1661                                                     | Review + flight tracking.                        |
