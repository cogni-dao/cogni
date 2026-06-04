---
name: provision-env
description: >
  Provision (or reprovision) a full environment — candidate-*, preview, or production — via the
  runner-owned `provision-env.yml` workflow. Covers the before (prereqs + minting secrets), the
  dispatch, the phase map, the hard-won gotchas that turn a "green" provision into a silent
  half-deploy, and the after (verify + decommission). Use when standing up a new env, reprovisioning
  a dead one, debugging a provision that "succeeded" but isn't serving, or when someone says
  "provision prod / candidate-b", "the new VM isn't up", "ImagePullBackOff after provision",
  "apex cut over to an empty VM", "525 after provision", "operator pod won't start".
  Sibling to `docs/runbooks/fork-quickstart.md` (the forker's zero-to-green) — this is the
  operator's reference for ANY env on the hub.
---

# provision-env — stand up an environment end-to-end

## The one mental model (read this first)

**Provision builds the house. Promote fills the furniture. They are different steps.**

- **Provision** (`provision-env.yml`) = substrate: Cherry VM → k3s → Compose infra (postgres, doltgres, temporal, litellm, redis, alloy) → OpenBao + ESO → Caddy edge → DNS → seeds the `deploy/<env>-<node>` branches → applies Argo ApplicationSets.
- **Promote** (`promote-and-deploy.yml`, the `/promote` skill) = fills the deploy branches with **real, proven per-node image digests** → Argo deploys the actual apps.

A provision is *supposed* to leave you at running apps (it seeds digests for nodes its seed-source runs). But **it routinely leaves gaps that a green workflow hides** — placeholder digests, missing `local_certs`. Those are bugs/gaps, not "by design." This skill is the list of what to check and fix.

> `/version.buildSha` from **outside** the cluster is the only "is it really live" signal. The workflow conclusion lies (it can pass with dead pods, or fail while Argo heals the cluster behind it).

## BEFORE — prereqs (zero-spend, do all of them)

1. **Target GitHub environment exists** + carries the **minting secrets** (the run dies at "Write `.env.bootstrap`" if any are empty — this is the #1 first failure):
   - Per-env: `CHERRY_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `GH_ADMIN_PAT`, `GH_ADMIN_USERNAME`
   - Repo-level: `CHERRY_AUTH_TOKEN`
   - Verify: `for k in CHERRY_PROJECT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ZONE_ID GH_ADMIN_PAT GH_ADMIN_USERNAME; do gh api repos/<owner>/<repo>/environments/<env>/secrets/$k >/dev/null 2>&1 && echo "✅ $k" || echo "❌ $k MISSING"; done`
2. **`GH_ADMIN_PAT` = a dedicated BOT, never a human token.** Use the automation bot account (e.g. `Cogni-1729`), **classic** PAT with `repo, workflow, write:packages` (`admin:repo_hook` if webhooks). Fine-grained PATs **cannot reach org-owned repos from an outside collaborator** — classic follows the account's actual access. `GH_ADMIN_USERNAME` must equal `gh api user --jq .login` of that token.
3. **App + external secrets present on the env** (`OPENROUTER_API_KEY`, `EVM_RPC_URL`, `POSTHOG_*`, `POLYGON_RPC_URL`, plus DoltHub / OAuth / Tavily / Privy / Langfuse if the node uses them). They reach the pod only if they're also in the runner env-block of `provision-env.yml` + `NODE_BASELINE_KEYS` (`scripts/setup/lib/reconcile-secrets.sh`).
4. **Cloudflare token scope = DNS:Edit + Zone Settings:Edit** (the run hard-fails at zero spend if only DNS:Edit).
5. **Generate + SAVE an encryption passphrase** — you need it later to decrypt the init artifacts (kubeconfig, vm-key). `openssl rand -hex 24 > .local/<env>-init-passphrase.txt`.
6. **Production only:** know your **rollback anchor** (the current live VM IP) before dispatch — provisioning repoints the apex (see Gotcha 1).

## DISPATCH

```bash
gh workflow run provision-env.yml --repo <owner>/<repo> \
  -f env=<candidate-a|candidate-b|preview|production> \
  -f encryption_passphrase="$(cat .local/<env>-init-passphrase.txt)"
# run a branch's version with --ref <branch> (e.g. to test a renderer/secrets fix before main)
```

## Phase map (where things die)

| Phase | Does | Common failure |
| --- | --- | --- |
| Write `.env.bootstrap` | maps GH secrets → runner | **missing minting secret** (empty `GH_ADMIN_PAT`) |
| Restore prior init-artifact | re-run idempotency | prior artifacts encrypted with a *different* passphrase → abort (delete prior VM+SSH key, or reuse passphrase) |
| 3 · Provision VM (tofu) | Cherry VM + DNS | adopt-vs-create; ephemeral tofu state on runner |
| **4b · DNS** | **cuts over apex + node subdomains to the new VM** | **production = LIVE cutover before apps exist (Gotcha 1)** |
| 4b.5 · Seed deploy branches | seeds digests | **placeholder digests (Gotcha 2)**; **H7 divergence (Gotcha 4)** |
| 5 · Compose | infra + Caddy | db-backup OOM on a fresh 6gb VM (transient) |
| 5b/5c · OpenBao + ESO + seed | secrets substrate | quoted secret values (Gotcha 6) |
| 5f · deploy-infra | Compose runtime | required-secret gaps (e.g. `POSTHOG_*`/`POLYGON_RPC_URL` if unset) |
| 7 · ApplicationSets | Argo deploys apps | placeholder digest → ImagePullBackOff |
| 9 · `/readyz` verify | 5-min/node | cascades red if scheduler-worker is down (Gotcha 11) |

## GOTCHAS — every one of these cost hours

1. **Apex cutover is in Phase 4b, BEFORE apps deploy (Phase 7).** For `production`, `cogni_operator_domain_for_env(production) = cognidao.org` (apex) — provisioning **repoints the live apex to the new, app-less VM for 10–20 min.** A failed run leaves the apex on a dead VM (a DNS time-bomb under resolver cache). **Always** have the old VM IP and roll the apex back if it goes sideways. Cleaner: **blue-green** — provision with `DOMAIN=<env>-next.<root>` override, validate the operator fully, then flip the apex by hand.
2. **Placeholder image digests = ImagePullBackOff that NEVER self-heals.** Nodes the seed-source doesn't run get `ghcr.io/.../cogni-template:<env>-placeholder-<node>` (a fake tag). **Each node has its OWN image** (same repo name, different digest) — do NOT reuse one node's digest for another (node-template's lacks `nodes/operator/app/migrate.mjs` → `MODULE_NOT_FOUND` in the migrate init container). **Fix:** get the correct per-node digest from a healthy env (`KUBECONFIG=.local/candidate-a-kubeconfig.yaml kubectl get deploy -n cogni-candidate-a -o custom-columns=NAME:.metadata.name,IMG:.spec.template.spec.containers[0].image`), patch each `deploy/<env>-<node>` overlay (`infra/k8s/overlays/<env>/<node>/kustomization.yaml`: replace `newTag: "*placeholder*"` with `newName + digest`), push, `kubectl -n argocd annotate app <env>-<node> argocd.argoproj.io/refresh=hard --overwrite`. The real fix = provision seeds real per-node digests (or run `/promote`).
3. **`local_certs` missing → Caddy 525 on every public host.** The rendered Caddyfile has bare site blocks (no TLS directive) → Caddy attempts Let's Encrypt **behind the Cloudflare proxy** → challenge can't reach origin → no cert → `tlsv1 internal error` → CF returns 525. The zone SSL mode is `full`, so the fix is **`local_certs`** (self-signed, CF Full accepts it). Manual: add `local_certs` inside the global `{ }` block of `/opt/cogni-template-edge/configs/Caddyfile.tmpl` on the VM (before the `log {` line), `docker restart cogni-edge-caddy-1`. Durable fix = `scripts/ci/render-caddyfile.sh` emits `local_certs` in its global block. (A pre-existing env may "work" only because it got an LE cert during an old grey-cloud window.)
4. **H7 — preview/prod deploy-branch divergence.** preview/production refuse force-update; Phase 4c commits `env-state.yaml` on top of the seed, so the tip is always ahead → re-runs abort at Phase 4b.5. **Clear `deploy/<env>*` branches before re-dispatch** (candidate-* auto-force, so this only bites preview/prod). They re-seed clean.
5. **Re-run trap.** "Restore prior init-artifact keys" aborts if a previous run uploaded artifacts under a *different* passphrase. Delete the prior Cherry VM + SSH key (Cherry API/portal) and re-dispatch, or re-run with the original passphrase.
6. **Quoted secret values brick init.** `gh secret set` of a value that includes literal quotes (`'https://...'`) stores the quotes → URL-validated fields (`EVM_RPC_URL`, `POSTHOG_HOST`) fail the Zod schema → `/readyz` 503 init-loop. `.env.*` files are quoted (fine for `source`, **not** for verbatim `gh secret set`). Strip quotes before setting; operator-200 on the *old* prod proves nothing about the *new* secrets path.
7. **`.env.bootstrap` extraction traps.** Lines carry inline comments and a commented stale value, and `GITHUB_ADMIN_*` (file) vs `GH_ADMIN_*` (GH secret) differ. Extract with `grep -m1 "^KEY=" f | cut -d= -f2- | awk '{print $1}' | sed "s/['\"]//g"` (first field, quote-stripped) — naive `cut -d= -f2-` grabs the trailing comment.
8. **You CANNOT debug app failures from `gh run`.** The run shows phase text only; the real failure (ImagePullBackOff, init `MODULE_NOT_FOUND`, 525) lives in the cluster and Loki. Two access paths:
   - **kubeconfig** from the init artifacts (after the run ends): `gh run download <id> --name <env>-init-artifacts`, decrypt each `*.enc` with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:<PP>`, then `KUBECONFIG=.../<env>-kubeconfig.yaml kubectl ...`.
   - **Loki (no cluster access needed, works mid-run):** prod ships k8s-events to Grafana Loki — `{env="<env>"} |~ "(?i)imagepull|backoff|oom|evicted|context deadline"`. This is how you read the real pull error while Phase 9 is still grinding.
9. **Argo `selfHeal=true` reverts kubectl hacks.** `kubectl set image` / `edit` gets reverted to the deploy-branch state within ~3 min. **Fix the deploy branch** (push) — that's the source of truth.
10. **GHCR throttle ≠ placeholder.** A fresh 6gb-shared VM pulling 5 images at once can transiently `BackOff` (recovers). A placeholder tag `BackOff`s forever. Distinguish via Loki: a `:<env>-placeholder-<node>` tag is the never-heals case; a real `@sha256:...` that's slow is transient.
11. **`/readyz` cascade.** Every node's `/readyz` asserts scheduler-worker connectivity. If scheduler-worker is down (placeholder/ImagePull), **all** nodes report 0/1 + Phase 9 fails everything — looks like 5 failures, is 1 root cause. Fix scheduler-worker → the rest go Ready.
12. **Postgres root-password drift wedges the WHOLE infra deploy (and looks like an alloy/observability failure — it isn't).** `POSTGRES_PASSWORD` is honored only at **first-init of an empty volume**. After a re-provision or a `POSTGRES_ROOT_PASSWORD` rotation, the persisted `postgres_data` volume keeps the **old** password while `deploy-infra` renders `.env` from the **GH-secret SSOT** → `db-provision`'s TCP+scram auth fails, spins its full 120s, and `deploy-infra.sh` aborts at the `db-provision` step. The ERR-trap diagnostic then dumps `alloy "unsupported protocol scheme"` + "unhealthy containers" — **red herrings**: alloy/s-ui/git-sync/repo-init/alloy-k8s-events have **no healthcheck** (Docker reports `null`, not unhealthy), and the empty-Loki-URL line is a transient of that one re-render. The real line is `❌ Timed out waiting for Postgres` + `FATAL: password authentication failed for user "postgres"`. **Downstream blast radius:** the abort happens *before* deploy-infra's Step-7 k8s-Secret write, so the `<node>-node-app-secrets` Secret is never refreshed → every catalogued **external** key (`GH_REVIEW_APP_*`, `DOLTHUB_*`, `PRIVY_*`, `LANGFUSE_*`, OAuth) stays **empty** in the pod even though it's present in the GH env + carried in the promote-and-deploy env block. Fix is in git (idempotent, self-healing): `deploy-infra.sh` reconciles the superuser password via the postgres image's `local … trust` unix socket (`compose exec … ALTER USER`) before `db-provision`, and `postgres-init/provision.sh` re-asserts the app/service role passwords on the "already exists" branch. Manual unwedge if you hit an unpatched env: `docker exec cogni-runtime-postgres-1 psql -U postgres -c "ALTER USER postgres PASSWORD '<.env value>'"` (and app_user / service user), then re-run the deploy.

## AFTER — verify + custody

```bash
KUBECONFIG=.local/prod-art/<env>-kubeconfig.yaml kubectl get pods -n cogni-<env>   # all 1/1
curl -s https://<public-host>/readyz   # 200 — and curl /version, confirm buildSha
```

- **All pods 1/1**, not just a green run.
- Move `.local/<env>-openbao-init.json` + `<env>-vm-key` + `<env>-kubeconfig.yaml` to a password manager; delete the artifact from the run page (1-day retention is a safety net, not custody).
- **Production:** keep the old VM as the rollback anchor until the new apex is proven, then decommission (delete the old Cherry VM, prune stale DNS).

## Linked guides

- [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md) — forker's zero-to-green (the human seam: bot PAT + minting secrets)
- [`docs/guides/create-env.md`](../../../docs/guides/create-env.md) — env stand-up + the known e2e gaps
- [`/promote`](../promote/SKILL.md) — fill real per-node digests (the app layer; production is human-gated)
- [`/cicd-secrets-expert`](../cicd-secrets-expert/SKILL.md) — minting vs runtime secrets, OpenBao/ESO, the quote/extraction traps
- [`/devops-expert`](../devops-expert/SKILL.md) — pipeline + VM SSH policy (candidate-a write-OK, never prod)
- `.github/workflows/provision-env.yml` · `scripts/setup/provision-env-vm.sh` · `scripts/ci/render-caddyfile.sh` · `scripts/setup/lib/reconcile-secrets.sh` — verify claims against code
