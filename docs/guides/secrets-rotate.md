---
id: secrets-rotate-guide
type: guide
title: Rotate a Secret
status: draft
trust: draft
summary: How to rotate a secret — routine, emergency, and rollback. Standardized cadences per class, one CLI command per scenario, zero git changes, audit-logged via OpenBao + Loki.
read_when: Rotating a secret on schedule, responding to an incident, or rolling back a bad rotation.
owner: derekg1729
created: 2026-05-19
verified: 2026-06-04
tags:
  - secrets
  - rotation
  - soc2
  - guides
---

# Rotate a Secret

> Like `secrets-add-new.md`, this is mostly one command. The complexity isn't in the mechanics — it's in choosing the right cadence per secret class and knowing the rollback path.

## Rotation cadence by class

Per [NIST SP 800-57 §8 Key States](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final), every key has a lifecycle. Cogni's cadence table:

| Class                      | Cadence                                   | Mechanism                                                                                                                                                      |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dynamic DB credentials** | per-session (≤1h TTL)                     | OpenBao DB engine issues per-session; old expires automatically. Pod re-auths transparently.                                                                   |
| **Routine app tokens**     | quarterly                                 | `pnpm secrets:rotate` generates new value; ESO + Reloader handle propagation.                                                                                  |
| **External API keys**      | annually                                  | Manual mint at issuer + `pnpm secrets:rotate`. Some issuers expose rotation APIs (see "Issuer-driven" below).                                                  |
| **Bootstrap tokens**       | annually                                  | Cherry / Cloudflare / GH PAT / OpenRouter. Re-mint at the issuer, then `pnpm secrets:set` or `gh secret set` (for chicken-and-egg GH env values).              |
| **AEAD / encryption keys** | every 6 months OR on suspected compromise | Special handling — two-step (encrypt new + decrypt old) required to prevent data loss. Lands with task.5056 (Reloader) + the dedicated AEAD migration runbook. |
| **ESO seed token**         | per-pod-lifetime                          | Automated by Kubernetes ServiceAccount token rotation. **Never touched manually.**                                                                             |
| **Emergency (compromise)** | immediate                                 | Force-sync; alert chain; incident report. See "Emergency rotation" below.                                                                                      |

## Routine rotation

The 95% case. Generate-then-rotate, zero downtime, zero git changes.

```bash
# Today: rotate = generate locally + `pnpm secrets:set`. The dedicated
# `pnpm secrets:rotate` wrapper (auto-generate + write + force-sync) is
# tracked as a follow-up under proj.security-hardening; the underlying
# primitive is identical to `secrets:set` (bao kv patch).
NEW=$(openssl rand -hex 32)
printf '%s' "$NEW" | pnpm secrets:set candidate-a node-template AUTH_SECRET
unset NEW
# Prereq: BAO_ADDR + BAO_TOKEN per docs/guides/secrets-add-new.md
```

What happens next:

```
   t=0     bao kv patch cogni/candidate-a/node-template AUTH_SECRET=<new>
   t=0     OpenBao audit log entry written (actor, path, version, timestamp)
   t≤1h    ESO refreshInterval expires; ESO reads OpenBao path
   t≤1h+   ESO updates k8s Secret <service>-env-secrets in cluster
   t<1m    Stakater Reloader observes Secret change
   t<1m+   Reloader triggers rolling restart on annotated Deployment
   t≤2m    New pods start with new env var value; old pods drain
   t≤2m+   Old AUTH_SECRET no longer in use; prior version retained in OpenBao
```

**No PR. No YAML edit. No `kubectl apply`. Just one CLI call + time.**

If you need the rotation applied immediately (e.g., revoking access for a departing contractor), annotate the ExternalSecret to force-sync after the write:

```bash
kubectl annotate externalsecret -n cogni-candidate-a node-template-env-secrets \
  force-sync=$(date +%s) --overwrite
# ESO syncs in seconds (not the configured 1h). Reloader restarts the pod.
# Propagation completes in <2 minutes.
```

## Rotation for keys you don't generate locally

Some secrets are values issued by external systems (OpenAI keys, OpenRouter keys, Cherry tokens, GH PATs). You can't `--generate-new` for those.

```bash
# 1. Mint new value at the issuer (browser, dashboard, API).
# 2. Apply it via the CLI in interactive mode (prompts for value).
#    Prereq: BAO_ADDR + BAO_TOKEN (port-forward + bao login).
pnpm secrets:set production poly OPENAI_API_KEY
# Prompts: "Value for cogni/...: " (secure input; never echoes)
# Writes via bao kv patch, preserves prior version
# 3. Verify new key is in use (your app's health endpoint or external API logs).
# 4. Revoke the old key at the issuer (only AFTER confirming new key is in production).
```

The two-step (write new, verify, then revoke old) prevents the "I rotated and now the service is down" failure mode. **Always verify new credential is in use before revoking the old at the issuer.**

## Issuer-driven rotation (top-shelf — for the future)

Some external services (GitHub, OpenRouter) expose rotation APIs that let you generate-new-then-invalidate-old atomically. The operator app's future rotation cron will call these for you on the annual cadence. Until that ships, manual mint + CLI rotate is the canonical flow.

## Emergency rotation (suspected compromise)

When you have reason to believe a secret has been exposed (laptop theft, accidental commit, audit finding, ex-employee, suspicious access pattern in OpenBao audit log):

```bash
# 1. Rotate immediately to lock out the old value.
pnpm secrets:set production poly OPENAI_API_KEY
kubectl annotate externalsecret -n cogni-production poly-env-secrets \
  force-sync=$(date +%s) --overwrite
#    (interactive prompt for new value, ESO force-sync, pod restarts in <2 min)

# 2. Revoke the old value at the issuer
#    Don't wait for the standard two-step verification — for emergency, kill the old key immediately

# 3. File an incident report
#    work item type: incident
#    project: proj.security-hardening
#    title: "Suspected compromise of <env>/<service>/<KEY>"
#    body: timeline + audit-log evidence + actions taken + follow-ups

# 4. Audit-log review
#    Query OpenBao audit (via Loki):
#    {component="openbao", path=~"cogni/<env>/<service>/<KEY>.*"} |= "read"
#    Look for unexpected actors, IPs, timestamps in the 30 days before the compromise window
```

The OpenBao audit log is shipped to Loki via Alloy (`{component="openbao"}`). Query examples appear at the bottom of this guide under "Audit + evidence".

## Rollback (the rotation was bad)

OpenBao KV v2 retains prior versions. If the new value turned out to be invalid (e.g., the new API key was typo'd or the issuer rejected it):

```bash
# Inspect version history
bao kv metadata get cogni/<env>/<service>
# Output shows current_version, oldest_version, version history

# Roll back to a specific prior version
bao kv rollback -version=<N> cogni/<env>/<service>
# This creates a NEW version with the contents of version <N>; original audit trail preserved
```

ESO + Reloader propagate the rollback the same way they propagate a forward rotation. **Versions are never destroyed pre-incident** (per `spec.secrets-management § VERSIONED_KV_IS_AUDIT_SUBSTRATE`); rollback is always available within the retention window (default ≥10 versions, ≥50 for production-critical paths).

## Rotating a static DB role password (today — pre-dynamic-creds)

DB **role** passwords (`app_user`, `app_service`, the readonly role, Doltgres `knowledge_reader`/`knowledge_writer`) are the one case where the zero-touch flow above does **not** apply yet. The role is created **set-once** by `db-provision` and never re-`ALTER`ed (Invariant 15 / bug.5002), so a plain `bao kv patch` of `DATABASE_URL` does **not** reach the live Postgres role — ESO would hand the pod a password the DB never adopted → `28P01`. Until Phase 2 of the DB-cred migration lands (`deploy-infra` reading role passwords from OpenBao — see [`secrets-management.md` → DB-credential provisioning](../spec/secrets-management.md)), rotating a static DB role password is a **deliberate, single-window two-source operation**:

```bash
# 1. Write the new password to OpenBao (the source of record).
printf '%s' "$NEW" | pnpm secrets:set <env> <service> APP_DB_PASSWORD
#    (also re-patch the composed DATABASE_URL key if your catalog stores it separately)

# 2. Apply the SAME value to the live role yourself — it will NOT self-heal.
#    Use the OpenBao value you just wrote (you are the single writer this window),
#    via the superuser socket on the VM. NOT a divergent .env value (that is bug.5002).
ssh <vm> 'docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -v pw="$NEW" \
  -c "ALTER ROLE app_user WITH PASSWORD :'"'"'pw'"'"';"'
#    …or just re-run the env provision, which re-reads the same source.

# 3. Force-sync ESO so the pod adopts the new DATABASE_URL in lockstep with step 2.
kubectl annotate externalsecret -n cogni-<env> <service>-env-secrets \
  force-sync=$(date +%s) --overwrite
```

Do all three in one change-window — a gap between steps 1/3 and step 2 is a live `28P01` window. **This manual lockstep is precisely the toil the migration eliminates:** after Phase 2, step 2 happens automatically on the next deploy (deploy-infra reads the role password from OpenBao); after Phase 3 (below) there is no static password to rotate at all.

## Dynamic database credentials (the production endgame)

For production DB access, the canonical pattern is **OpenBao DB engine dynamic credentials** — each application session requests a fresh, short-lived credential from OpenBao; the credential expires automatically; no static password exists.

```yaml
# Approximation of the ExternalSecret for dynamic DB creds (lands with Crawl-row-3)
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: poly-db-dynamic
spec:
  refreshInterval: 15m # Refresh well before TTL
  secretStoreRef:
    name: openbao-db-engine
    kind: ClusterSecretStore
  target:
    name: poly-db-dynamic-secret
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .database }}?sslmode=require"
  data:
    - secretKey: username
      remoteRef: { key: database/creds/poly-app-role, property: username }
    - secretKey: password
      remoteRef: { key: database/creds/poly-app-role, property: password }
    - secretKey: host
      remoteRef: { key: database/static/host }
    - secretKey: database
      remoteRef: { key: database/static/name }
```

OpenBao DB engine + ESO + Reloader together make this work zero-downtime: every refresh issues a new password, ESO templates a new `DATABASE_URL`, Reloader restarts the pod, pod re-auths with the new credential, old credential expires.

This pattern lands as part of Crawl row 3 of [`proj.security-hardening`](../../work/projects/proj.security-hardening.md). Until then, app DB credentials use the static-rotation path described above.

## Audit + evidence (SOC 2 CC7.2 / CC8.1)

Every rotation generates an OpenBao audit log entry shipped to Loki:

```
{component="openbao"} | json | path =~ "cogni/<env>/.*" | operation=~"create|update|patch"
```

For SOC 2 evidence collection (e.g., "show me all production secret rotations in Q1"):

```
{component="openbao"} | json
  | path =~ "cogni/production/.*"
  | operation=~"create|update|patch"
  | __error__=""
  | line_format "{{.time}} {{.auth.display_name}} {{.path}} v{{.response.data.version}}"
```

This stream is the evidence. No spreadsheet, no manual audit log — the canonical record IS the OpenBao + Loki query.

## Anti-patterns this guide assumes you won't do

- Edit the k8s Secret YAML directly (`kubectl edit secret`) — bypassed by ESO on next reconcile; audit trail lost
- Use `bao kv put` instead of `bao kv patch` (replaces all keys; CLI handles this for you)
- `bao kv destroy` versions pre-incident — versions are the audit substrate; only destroy with documented incident justification
- Skip the issuer-side revocation after rotating an external API key
- Skip the audit-log review after an emergency rotation
- Touch the `OPENBAO_SEED_TOKEN` manually — it has its own automated rotation via Kubernetes auth method renewal; see the "Substrate-token rotation" section below if you genuinely need to rotate the root token
- Set the ESO refresh interval shorter than 5 minutes — read pressure on OpenBao; use force-sync annotation for immediate needs instead

## Substrate-token rotation (root token + unseal keys)

The root token + unseal keys captured at init by `provision-env-vm.sh`
Phase 5b are **break-glass credentials** — they exist briefly during
unseal+policy-write, and per spec [Invariant 13 NO*OPERATOR_ROOT_TOKEN*
ON_LAPTOP](../spec/secrets-management.md) nothing reads them from disk
post-bootstrap. The day-to-day path is Kubernetes auth method + per-role
policies. Rotate the root annually OR after any suspected compromise of
`.local/<env>-openbao-init.json`.

```bash
# Performed against the cluster directly (kubectl exec; no SSH-from-laptop).
# Operator's kubeconfig must reach the openbao namespace.

# 1. Initialize a fresh root-generation flow.
kubectl exec -ti -n openbao openbao-0 -- bao operator generate-root -init
# Provide unseal-key shares until threshold is reached:
kubectl exec -ti -n openbao openbao-0 -- bao operator generate-root \
  -nonce=<nonce> <unseal-key>

# 2. Decode the new root using the OTP from step 1.
kubectl exec -ti -n openbao openbao-0 -- bao operator generate-root \
  -decode=<encoded_root> -otp=<otp>

# 3. Revoke the old root token via the old token.
BAO_TOKEN=<old-root> kubectl exec -ti -n openbao openbao-0 -- bao token revoke -self

# 4. Store the new root in your password manager. Do NOT save it to a
#    long-lived file under .local/ — it is break-glass only. Update
#    .local/<env>-openbao-init.json only if your incident-response
#    workflow expects to re-run provision-env-vm.sh Phase 5b restoration.
```

Rotating unseal keys (`bao operator rekey`) is rare; the standard path is
to re-init from a fresh init artifact only after a full data export +
restore, which is incident-territory work and lives in the eventual
SOC 2 incident-response runbook.

## Upgrade discipline (OpenBao + ESO chart bumps)

Both chart versions are pinned in `infra/k8s/argocd/{openbao,external-secrets}/kustomization.yaml`.

1. Bump the `helmCharts[0].version`.
2. `kustomize build --enable-helm infra/k8s/argocd/<name>/` locally to confirm the new render diffs cleanly.
3. Run the rotation drill above on candidate-a (write → ESO sync → pod restart → new value in effect) to confirm the upgrade did not regress the path. ESO occasionally renames CRD versions between minor releases; watch for `kubectl wait` failures during `provision-env-vm.sh` Phase 5b re-apply.
4. Do not bump OpenBao and ESO in the same PR unless the rotation drill is included — pairing a sealed-state regression with an auth-method regression makes the failing axis ambiguous.

## Related

- [`docs/spec/secrets-management.md`](../spec/secrets-management.md) — canonical contract
- [`docs/guides/secrets-add-new.md`](./secrets-add-new.md) — adding new secrets
- [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md) — bootstrap flow (substrate install + unseal + role bind happen here)
- [`proj.security-hardening`](../../work/projects/proj.security-hardening.md) — parent project + SOC 2 control mapping
- [NIST SP 800-57 Part 1 Rev 5 §8 Key States](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
- [OpenBao KV v2 versioned secrets](https://openbao.org/docs/secrets/kv/kv-v2/)
- [Stakater Reloader docs](https://github.com/stakater/Reloader#how-it-works)
