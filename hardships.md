# Provisioning Hardships

> Dated log of every blocker, surprise, undocumented step, or doc-vs-reality drift hit while
> driving a real env up. Per [`docs/runbooks/fork-quickstart.md`](docs/runbooks/fork-quickstart.md) §3.
> **Goal: each entry below must be ironed out so `provision-env.yml` + fork-quickstart are seamless
> (zero manual recovery) for a non-privileged node-template forker.** Triage these into
> [`docs/guides/create-env.md`](docs/guides/create-env.md) §"Known gaps" + work items as they're fixed.

Legend: 🔴 hard-fails the provision · 🟡 friction / silent drift · ✅ fixed (PR linked)

---

## 2026-06-03 — Reprovisioning Cogni-monorepo candidate-a + standing up preview from zero

Drove `provision-env.yml` for `candidate-a` (succeeded after 3 code fixes) then `preview`
(6 dispatches, each a distinct failure). The provisioner is **not re-run-friendly** and assumes
state/secrets that a fresh env doesn't have.

### ✅ H1 — Phase 7 applied a monolithic AppSet the per-node migration deleted
`provision-env-vm.sh` Phase 7 applied a single `${env}-applicationset.yaml`, but bug.0378/#1465
split it into per-node `${env}-<node>-applicationset.yaml`. candidate-a/preview/prod have no
monolith → `ApplicationSet file not found` → hard fail at the last phase. **Fixed: #1469** (glob
per-node, monolith fallback for candidate-b).

### ✅ H2 — Init-artifact custody was fail-closed → orphaned, unrecoverable VM
Encrypt+upload of vm-key/kubeconfig/OpenBao-unseal-keys were gated on bootstrap success, so a
*late* failure shredded them on cleanup → a live VM nobody could SSH/kubectl into (had to delete
from the Cherry portal). **Fixed: #1469** (`if: always()` on encrypt+upload). This fix is load-
bearing — every hardship below produced a recoverable box because of it.

### ✅ H3 — ExternalName host rewrite doubled the env prefix → NXDOMAIN
`provision-env-vm.sh` rewrote the pod→host ExternalName with `s/vm.cognidao.org/$VM_DNS_HOST/`,
assuming a bare placeholder. The migrated overlays carry the qualified `cogni-<env>.vm.cognidao.org`
→ doubled to `cogni-candidate-a.cogni-candidate-a.vm.cognidao.org` → every pod 503s on
temporal/redis. **Fixed: #1470** (idempotent `([a-z0-9-]+\.)*vm\.cognidao\.org`, self-heals).

### 🔴 H4 — Per-env minting secrets silently absent; no pre-flight, no seeder
`preview` was missing `GH_ADMIN_PAT` + `GH_ADMIN_USERNAME` (candidate-a had them; nobody set
preview's). Provision fails at the `.env.bootstrap` validation step. Nothing lists/seeds the
5 required minting secrets (`CHERRY_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
`GH_ADMIN_PAT`, `GH_ADMIN_USERNAME` + repo-level `CHERRY_AUTH_TOKEN`) per env.
**Fix-forward:** a pre-flight that names every missing minting secret for the target env at zero
spend, and/or `pnpm setup:secrets --env <env> --minting-only`. Document the 5 as a hard gate in
fork-quickstart §6.2 with a one-line `gh api .../environments/<env>/secrets` verify.

### 🔴 H5 — `GITHUB_ADMIN_PAT=$(gh auth token)` placeholder trap
`.env.bootstrap` ships `GITHUB_ADMIN_PAT="$(gh auth token)"` — a laptop convenience that resolves
locally but, copied into a GH **env secret**, stores the literal string `$(gh auth token)` →
`gh api user` → `no oauth token found for github.com` → fail. Silent and easy to hit when seeding
a new env's secrets from `.env.bootstrap`.
**Fix-forward:** provision-env.yml pre-flight should reject a `GH_ADMIN_PAT` containing
`gh auth token`; fork-quickstart §6.2 must say "paste a **real** token, never the placeholder."

### 🟡 H6 — `install-tofu.sh` hits the unauthenticated GitHub API → rate-limited → flaky
`Failed to obtain the latest release from the GitHub API. Try passing --opentofu-version`.
Non-deterministic; cleared on re-run. Wastes a full dispatch.
**Fix-forward:** pin `OPENTOFU_VERSION` in `scripts/bootstrap/install/install-tofu.sh` (or auth the
releases call with `GITHUB_TOKEN`) so it never depends on anonymous API quota.

### 🔴 H7 — preview/prod deploy-branch divergence makes the provisioner un-re-runnable
Phase 4b.5 refuses to force-update `deploy/<env>` for preview/prod (candidate-* auto-force). But
Phase 4c commits `env-state.yaml` **on top of** the freshly-seeded branch, so the tip is always
ahead of the seed SHA → **every subsequent re-run sees "diverged" and hard-fails**. The only way
to retry preview is to `gh api -X DELETE` all `deploy/<env>*` branches first (there are ~7,
per-node). A failed run *recreates* them, so this trap re-arms on every attempt.
**Fix-forward:** make Phase 4b.5 treat "seed SHA + only Phase-4c env-state commits ahead" as
non-divergent and fast-forward; OR add an explicit `reseed=true` workflow input for greenfield
preview/prod; OR move the Phase 4c commit before the 4b.5 guard. As-is, preview/prod provisioning
is not idempotent.

### 🔴 H8 — `deploy-infra` `db-backup` OOM (exit 137) on first boot
`deploy-infra.sh:643` runs `$RUNTIME_COMPOSE --profile backup up --abort-on-container-exit
--exit-code-from db-backup db-backup`. On a fresh 6 GB VM the backup container gets OOM-killed
(137) during the simultaneous first-boot image-pull + container-start, and `--abort-on-container-
exit` hard-fails the whole provision. Non-deterministic — candidate-a (warm) passed the identical
step on the identical plan.
**Fix-forward:** skip `db-backup` when the DB is fresh/empty (nothing to back up), give it a memory
reservation, stagger Compose startup, or don't `--abort-on-container-exit` for the backup on the
first provision.

### 🟡 H9 — Fresh provision leaves the old env VM running (two VMs)
The provisioner created a **new** Cherry VM (`preview-cogni-dao-cogni`, fork-slug hostname) rather
than adopting the existing `preview-cogni` box, leaving two preview VMs. The old one must be deleted
by hand.
**Fix-forward:** adopt-by-env-label/import the existing VM, or emit an explicit "old VM still
running — delete `<id>` after cutover" step in the scorecard.

### 🟡 H10 — Human/vendor secrets (dolt + git) are never carried into OpenBao by provision
`DOLTHUB_*`, `DOLT_CREDS_*`, `GH_REVIEW_APP_*` are catalog-declared (A1) and present as GH env
secrets, yet a fresh provision leaves them unset in-pod → the DoltHub mirror + GitHub-App/VCS
wiring that "used to work" is gone. They are absent from **three** hand-maintained lists that all
drift from the catalog: `reconcile-secrets.sh::NODE_BASELINE_KEYS`, the `provision-env.yml` `env:`
block, and `bootstrap.sh`'s `.env.<env>` heredoc. The documented recovery ("post-provision
`pnpm secrets:set`") requires `kubectl port-forward` — **off-limits for a non-privileged forker**.
**Fix-forward:** derive the fan-out + the runner env-block from the catalog (single SSOT, no
hand-lists); build the non-privileged value-set path (operator-mediated Entry 3 `/secrets/declare`,
spec'd in `secrets-management.md`, not built). See the env-update.md two-half plan.

### 🟡 H11 — Init-artifact SSH key rejected by the VM (candidate-a)
The decrypted `<env>-vm-key` from the init artifact was rejected by the VM's `authorized_keys`
(`Permission denied (publickey)`), despite being a valid key. Diagnosis had to go through the
**kubeconfig** (`kubectl exec` into a pod to probe the VM's host ports) since SSH was unusable.
**Fix-forward:** verify the artifact key matches the key cloud-init/tofu injects; meanwhile document
kubeconfig-exec as the sanctioned no-SSH diagnostic path.

### 🟡 H12 — Process note: preview/prod retries need deploy-branch deletion FIRST
Re-dispatching preview without first deleting `deploy/<env>*` (recreated by the prior failed run)
re-triggers H7 in ~2 min — a known failure. Runbook for any preview/prod retry: **(1)** delete all
`deploy/<env>*` refs, **(2)** re-dispatch, **(3)** watch with ≤25 s cadence (these fail fast).
