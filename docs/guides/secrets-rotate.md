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

> Like `secrets-add-new.md`, this is mostly one command. The complexity isn't in the mechanics — it's in choosing the right cadence per secret class, picking the right lane (self-serve API vs break-glass CLI), and knowing the rollback path.

Use this only for secrets. Plain runtime config changes through GitOps
ConfigMaps or repo config; it does not rotate.

## Pick the lane first (same split as `secrets-add-new.md`)

Rotation is a re-write with a new value, so it uses the **same two lanes** as
adding a secret — choose before you touch anything:

| What you're rotating                                                                                                                | Lane                                                       | Who runs it                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| A `source: human` vendor value (OAuth secret, API key, `DOLT_CREDS_JWK`) **in the same env as the operator you call**               | ✅ **THE PATH — Self-serve API** (below)                   | node owner / their agent           |
| A `source: agent`/`derived` value the substrate mints (`AUTH_SECRET`, DB creds, DSNs)                                               | Substrate re-mints it — see "Substrate-owned values" below | the substrate (CI), automatically  |
| A `source: human` value in a **different env** than any operator that knows the node, or an env the API can't yet serve (cross-env) | ⚠️ **Break-glass operator-admin CLI** (`pnpm secrets:set`) | operator-admin (kube + writer JWT) |

The API contract, the `secrets_manager` grant, and the **live per-env status** are
single-sourced in the hub, not restated here (a git snapshot drifts):

> Recall **`node-self-serve-secrets`** — `GET /api/v1/knowledge/node-self-serve-secrets`.
> Code of record: `nodes/operator/app/src/app/api/v1/nodes/[id]/secrets/route.ts`.

## Preflight your auth — then read a failure as a STOP, not a detour

Nearly every "I'm blocked rotating X" story is a **credential problem wearing a
mechanics costume**. Answer "am I allowed to rotate here?" _before_ you write —
the API tells you in one call, and its error codes are the whole decision tree:

```bash
# Preflight: is my key live for this env? (200 = key valid + you're in this env)
curl -fsS -H "Authorization: Bearer $COGNI_API_KEY_<ENV>" https://<operator-host>/api/v1/nodes/<id>
```

Then attempt THE PATH (below). If the self-serve POST returns:

| Response                 | What it means                                                                  | The ONLY correct next move                                                              |
| ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **401**                  | Your `COGNI_API_KEY_<ENV>` is **expired** (env `AUTH_SECRET`-rotation pattern) | Ask a human to refresh it in `.env.cogni`. **STOP.**                                    |
| **403 `authz_denied`**   | You lack `secrets_manager` on this env (a fresh agent key has none)            | `POST /nodes/{id}/access-requests {role:"secrets_manager"}` → owner approves. **STOP.** |
| **404 `node_not_found`** | Node isn't in that env's registry                                              | Wrong env/host, or node not provisioned there. **STOP.**                                |
| **403 `key_reserved`**   | Substrate-owned value — not yours to rotate                                    | See "Substrate-owned values" below. **STOP.**                                           |

> 🚧 **401/403/404 is terminal _for you_ — it is NOT a cue to fall back to the
> break-glass kube path.** `pnpm secrets:set`, kubeconfigs, `.local/` init
> artifacts, and OpenBao root tokens are **operator-admin custody, not a dev
> lane** — reaching for them means hunting stale artifacts on reprovisioned
> infra (the exact rabbit hole this warning exists to stop). A 30-second human
> key-refresh or `secrets_manager` grant unblocks the self-serve path. Escalate;
> don't spelunk.

## Routine rotation of a human value = self-serve API (THE PATH)

The default for rotating a vendor/human secret in the operator's own env. A node
owner granted OpenFGA `secrets_manager` on the node re-writes
`cogni/<env>/<node>/<KEY>` through the operator holding **only an API key** — no
kubeconfig, no OpenBao token, no laptop cluster access.

```bash
# op: "rotate" (semantically identical to "set" — writes a new KV version,
# preserves prior versions). `env` is REQUIRED and validated == the operator's
# own DEPLOY_ENVIRONMENT (409 wrong_operator_env on mismatch — never a silent
# wrong-env write). See secrets-add-new.md § "Self-serve API".
curl -fsS -X POST https://<operator-host>/api/v1/nodes/<id>/secrets \
  -H "Authorization: Bearer $COGNI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"env":"candidate-a","key":"OPENAI_API_KEY","value":"<new>","op":"rotate"}'
# Response: 200 { written, version, path }  (path = cogni/<env>/<node>/<KEY>, no value)
```

**Prerequisites** (same as add-new's THE PATH):

- The node must already exist in that env's `nodes` registry — the route resolves
  `id` against the registry and returns `404 node_not_found` otherwise.
- A `secrets_manager` grant on the node (`POST /nodes/{id}/access-requests {role:"secrets_manager"}` → owner approves).
- You call the host that serves your target env (prod host serves `production`,
  test host serves `candidate-a`). Cross-env is not yet API-reachable — use the
  CLI (below).

**Two-step for a rotation you must not break:** for a `source: human` key issued
by a vendor, always **write new → verify the new value is in use → revoke the old
at the issuer**. Never revoke first. See "Rotation for keys you don't generate
locally" below.

Propagation after the write (identical for both lanes) is ESO → Reloader → pod
rolling-restart:

```
   t=0     OpenBao KV version written (actor, path, version, timestamp in audit log)
   t≤1h    ESO refreshInterval expires; ESO reads the OpenBao path
   t≤1h+   ESO updates k8s Secret <service>-env-secrets in cluster
   t<1m    Stakater Reloader observes the Secret change → rolling restart
   t≤2m    New pods start with the new value; old pods drain; prior version retained in OpenBao
```

Need it applied immediately (revoking access for a departing contractor)?
Force-sync ESO instead of waiting for the refresh interval:

```bash
kubectl annotate externalsecret -n cogni-<env> <service>-env-secrets \
  force-sync=$(date +%s) --overwrite
# ESO syncs in seconds (not the configured 1h); Reloader restarts; <2 min total.
# (force-sync needs kube custody — see secrets-add-new.md §3.)
```

## Substrate-owned values (never rotate by hand)

`source: agent`/`derived` keys — `AUTH_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`,
DB creds, DSNs, `GH_WEBHOOK_SECRET` — are minted per node by `secret-materialize`
on every flight/promote and are on the self-serve route's substrate-reserved
denylist (`403 key_reserved`). Do not `pnpm secrets:set` them either. If one is
genuinely compromised, that is a substrate re-key (re-run materialize / re-provision),
not a manual rotation — the static-DB-role and immutable-init cases below cover
the exceptions where a live resource also holds state.

## Rotation cadence by class

Per [NIST SP 800-57 §8 Key States](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final), every key has a lifecycle. Cogni's cadence table:

| Class                                    | Cadence                                   | Mechanism                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dynamic DB credentials**               | per-session (≤1h TTL)                     | OpenBao DB engine issues per-session; old expires automatically. Pod re-auths transparently.                                                                                      |
| **Routine app tokens** (`source: agent`) | quarterly                                 | Substrate re-mints via `secret-materialize`; ESO + Reloader handle propagation. Never hand-rotated.                                                                               |
| **External API keys** (`source: human`)  | annually                                  | Manual mint at issuer, then **self-serve API** (`POST /nodes/<id>/secrets` `op:rotate`) in the operator's own env. Some issuers expose rotation APIs (see "Issuer-driven" below). |
| **Bootstrap tokens**                     | annually                                  | Cherry / Cloudflare / GH PAT / OpenRouter. Re-mint at the issuer, then self-serve API (same-env human value) or `gh secret set` (for chicken-and-egg GH env values).              |
| **AEAD / encryption keys**               | every 6 months OR on suspected compromise | Special handling — two-step (encrypt new + decrypt old) required to prevent data loss. Lands with task.5056 (Reloader) + the dedicated AEAD migration runbook.                    |
| **ESO seed token**                       | per-pod-lifetime                          | Automated by Kubernetes ServiceAccount token rotation. **Never touched manually.**                                                                                                |
| **Emergency (compromise)**               | immediate                                 | Force-sync; alert chain; incident report. See "Emergency rotation" below.                                                                                                         |

## Break-glass / cross-env CLI rotation (`pnpm secrets:set`) — LEGACY

> **⚠️ Not the routine path.** Use the [self-serve API](#routine-rotation-of-a-human-value--self-serve-api-the-path)
> above for a human value in the operator's own env. Reach for the CLI **only**
> when the API can't serve your case: a cross-env write (the target env's operator
> doesn't know the node yet), or genuine break-glass. It needs kube custody + a
> short-lived OpenBao writer JWT and is operator-admin-only. Full setup (kubeconfig,
> writer-token mint, ESO force-sync, process-level proof) lives in
> [`secrets-add-new.md` §3–8](./secrets-add-new.md#cli--kube-path-38--legacy--break-glass-admin).

```bash
# Prereq: BAO_ADDR + BAO_TOKEN (per secrets-add-new.md §3–5). Interactive mode
# (prompts for value; never echoes) — or pipe via stdin for a non-generatable
# value. `pnpm secrets:set` chooses bao kv patch (additive) automatically.
pnpm secrets:set <env> <service> <KEY>
# Then force-sync ESO (kube custody) if you need it live before the refresh interval.
```

The propagation, force-sync, and rollback semantics are identical to the
self-serve path (both end at `bao kv patch` → ESO → Reloader → pod).

## Rotation for keys you don't generate locally

Some secrets are values issued by external systems (OpenAI keys, OpenRouter keys, Cherry tokens, GH PATs). You can't generate these — a human mints them at the issuer.

```bash
# 1. Mint new value at the issuer (browser, dashboard, API).
# 2. Write it in — same-env human value → self-serve API (THE PATH):
curl -fsS -X POST https://<operator-host>/api/v1/nodes/<id>/secrets \
  -H "Authorization: Bearer $COGNI_API_KEY" -H 'content-type: application/json' \
  -d '{"env":"production","key":"OPENAI_API_KEY","value":"<new>","op":"rotate"}'
#    (cross-env / break-glass: `pnpm secrets:set production node-template OPENAI_API_KEY`)
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
#    Same-env human value → self-serve API (fastest, no kube custody needed):
curl -fsS -X POST https://<operator-host>/api/v1/nodes/<id>/secrets \
  -H "Authorization: Bearer $COGNI_API_KEY" -H 'content-type: application/json' \
  -d '{"env":"production","key":"OPENAI_API_KEY","value":"<new>","op":"rotate"}'
#    (cross-env / API unreachable → break-glass CLI:
#       pnpm secrets:set production node-template OPENAI_API_KEY)
# Then force-sync ESO so the new value lands in seconds, not on the refresh interval:
kubectl annotate externalsecret -n cogni-production node-template-env-secrets \
  force-sync=$(date +%s) --overwrite
#    (ESO force-sync, pod restarts in <2 min)

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

DB **role** passwords are not the same as API keys. The secret value lives in
OpenBao, but the database role also has state. For paths now covered by the
OpenBao read bridge (`deploy-infra` for shared infra DB roles and
`reconcile-substrate` for per-node app/service roles), the owning deploy lever
must read the OpenBao value and converge the role from that value. Never align a
role to a rendered VM `.env` copy.

For roles that are still set-once and not automatically ALTERed, a plain
`bao kv patch` does **not** reach the live Postgres role by itself. ESO would
hand the pod a password the DB never adopted -> `28P01`. Rotating one of those
static DB credentials is a deliberate, single-window operation:

```bash
# 1. Write the new password to OpenBao (the source of record).
printf '%s' "$NEW" | pnpm secrets:set <env> <service> APP_DB_PASSWORD
#    (also re-patch the composed DATABASE_URL key if your catalog stores it separately)

# 2. Apply the SAME value through the owning deploy/reconcile lever, or to the
#    live role yourself if no lever owns that role yet. It will NOT self-heal.
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

Do all three in one change-window — a gap between steps 1/3 and step 2 is a live
`28P01` window. **This manual lockstep is precisely the toil the migration is
eliminating:** covered roles converge from OpenBao on their owning deploy path;
after dynamic DB credentials land (below), there is no static password to rotate
at all.

## Immutable init-bound credentials (converge, don't rotate)

Some credentials are fixed when a stateful resource is **initialized** and have no in-place "set new password" operation afterward. For these, rotation as described above does not exist — there are only two moves: **converge** (make the OpenBao SSOT agree with the live resource) and **re-init** (destroy + recreate the resource, a data migration). Classify by custody, not by name: a value the catalog routes through OpenBao but whose live counterpart is set-once-at-init belongs to this class.

The current instance is the **Doltgres superuser** (`DOLTGRES_PASSWORD`): Doltgres 0.56.3 has no `ALTER` for it and supports only one server-wide root password (no per-database superuser — `databases.md §5.2`), so it is necessarily one env-wide value fixed at volume init. Its SSOT is operator-canonical and stored — `cogni/<env>/operator/DOLTGRES_PASSWORD` — rendered into every node's `DOLTGRES_URL` (a derived value; see [`secrets-classification.md`](../spec/secrets-classification.md) § "DATABASE_URL / … — derived, not catalog") and read by the provisioners. It is **never re-derived** (re-deriving from `POSTGRES_ROOT_PASSWORD` is what drifted prod and caused the 2026-06-10 `28P01`).

**Converge — the common case (restore/drift).** The live resource holds value `X`; make OpenBao agree. Non-destructive, zero data movement:

```bash
# Recover X from the running pod's env (the only authoritative place it survives),
# then write it to the SSOT. Never print X to chat/logs/argv.
# (Prereq: kubeconfig + BAO_ADDR/BAO_TOKEN per secrets-add-new.md §4.)
X=$(kubectl -n cogni-<env> exec deploy/operator -- printenv DOLTGRES_URL \
  | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')
printf '%s' "$X" | pnpm secrets:set <env> operator DOLTGRES_PASSWORD
unset X
```

**Re-init — genuine re-key (rare, destructive).** Export data → destroy + recreate the resource with a new value (set the SSOT _first_) → re-import. This is a data migration, run from a maintenance runbook with the resource briefly unavailable — not a rotation. The Doltgres volume procedure lives in the database spec ([`databases.md`](../spec/databases.md)); prefer converge unless the old credential is genuinely compromised.

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

## Rotating a projected secret: force the sync, do not shorten the interval

A rotation is **two facts** — written to OpenBao, and projected into the pod — with an ExternalSecret's `refreshInterval` between them. Closing that gap by lowering the interval is the wrong trade, and was rejected twice:

| option                                 | why not                                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refreshInterval: 1m`                  | 60× the OpenBao reads **forever** to shorten a gap that matters a few times a year. OpenBao is Shamir 1-of-1 with no auto-unseal and has already been OOMKilled once (`bug.5011`); it also multiplies audit volume by the same factor. |
| Operator pushes the sync after a write | The operator pod has **no ServiceAccount and no k8s identity**. Granting the internet-facing app RBAC to patch ExternalSecrets is a far larger blast radius than the gap it closes.                                                    |

**Do this instead.** A rotation always has an operator or agent in the loop, so make the sync part of the rotation rather than a property of the cluster:

```bash
export KUBECONFIG=<env kubeconfig>
TS=$(date +%s)
kubectl -n cogni-<env> annotate externalsecret <name> force-sync=$TS --overwrite
kubectl -n cogni-<env> delete pod -l app.kubernetes.io/name=<app>   # pods read envFrom once, at start
```

Propagation is seconds, the steady-state cost is zero, and no component gains a permission it did not need.

**Then prove it landed** — do not assume. Read the consumer back:

```bash
kubectl -n cogni-<env> logs -l app.kubernetes.io/name=<app> --tail=30 | grep wallet_verified
```

`bug.5142`'s credential fingerprint exists for exactly this: a pod holding a **revoked** credential looks identical to a healthy one, because the wallet is verified only at boot. Compare the fingerprint across two log lines and you know whether the rotation was picked up — no OpenBao access required.
