---
name: dns-ops
description: "DNS operations for Cogni multi-node infrastructure. Node app DNS is automatic + catalog-driven (do NOT hand-set it); this skill owns DNS trust boundaries, one-time Cloudflare zone setup, the env apex record, decommissioning a purged node's record, and protected-record safety. Use it whenever a test fleet, Akash workload, Cloudflare token, domain, zone, or node hostname is being created or changed."
---

# DNS Operations — Cogni Multi-Node

**Node app DNS is automatic, deterministic, and catalog-driven. Do NOT hand-create or `curl`-upsert per-node records.** A hand-made `<node>-<env>` record drifts from the catalog the next flight reconciles. This skill is for the _genuinely manual_ surface only: one-time Cloudflare zone setup, the env **apex** record, decommissioning a purged node, and protected-record safety.

## Test-fleet DNS boundary — as-will-be (new; still being refined)

> **New architecture, 2026-09-22.** `cogni-testing.org` has been acquired and delegated. The contract below is the intended steady state and is still being refined through the first real `spawny-boi` flight. Treat the design as authoritative; treat its rollout status as incomplete until the live proof at the end passes.

The candidate operator and disposable test workloads intentionally use different DNS zones:

| Concern                             | Canonical value                                                             | Authority                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| candidate operator/control endpoint | `test.cognidao.org`                                                         | production `cognidao.org` zone; do not move it                                                            |
| test-org Akash workload             | `<node>.cogni-testing.org`                                                  | isolated `cogni-testing.org` zone                                                                         |
| workload public-domain input        | `DOMAIN=cogni-testing.org` in `cogni-test-org/cogni-monorepo` `candidate-a` | non-secret GitHub environment variable                                                                    |
| shared substrate root               | `FORK_DOMAIN_ROOT=cognidao.org` (or its existing default)                   | names candidate-a's VM services; it is **not** the workload DNS zone                                      |
| DNS zone id                         | `cogni-testing.org` zone id                                                 | public identifier; the current materializer reads the candidate-a `CLOUDFLARE_ZONE_ID` environment secret |
| DNS writer credential               | token scoped only to `cogni-testing.org`                                    | candidate-a OpenBao `cogni/candidate-a/operator/CLOUDFLARE_API_TOKEN` → ESO `operator-env-secrets`        |

Cloudflare API-token permissions are zone-wide; they cannot be restricted to a record prefix. Therefore a test-fleet token for the `cognidao.org` zone is not isolated, even if an agent promises to write only `*-test` records. Never put the production-zone token, VM SSH key, or any other production credential in `cogni-test-org`.

The test GitHub App is deliberately broad inside `cogni-test-org`. That makes this boundary load-bearing: test-controlled desired state may choose a hostname or zone id, but the controller's token can mutate only `cogni-testing.org`.

### Bring `cogni-testing.org` online once

1. Add `cogni-testing.org` to Cloudflare and replace the registrar nameservers with the two Cloudflare nameservers. Verify delegation with `dig cogni-testing.org NS +short`.
2. In Cloudflare, set SSL/TLS encryption mode to **Full**. Akash workload records are proxied; do not grant settings-write merely to automate this one-time click.
3. Create a token with `Zone · DNS · Edit` and `Zone · Zone · Read`, restricted to the single `cogni-testing.org` zone.
4. Give the token to the secrets-manager lane, which writes it to candidate-a OpenBao and forces ESO refresh. Do not paste it into chat, a file, a PR, or GitHub Actions.
5. Set the test parent inputs: `DOMAIN=cogni-testing.org`; keep `FORK_DOMAIN_ROOT=cognidao.org`; set `CLOUDFLARE_ZONE_ID` to the new zone's id through the current candidate-a environment interface.
6. Prove the boundary with one disposable Akash node. Green means its generated `XComputeWorkload.spec.workload.publicHost` is `<node>.cogni-testing.org`, DNS exists in only that zone, `/version` returns the expected SHA, and the old-SHA → new-SHA probe has zero DNS/TLS/HTTP failures.

Do not create an apex/VM record for this Akash-only workload zone. Crossplane creates each workload CNAME from the provider endpoint. The candidate operator and shared substrate keep their existing records under `cognidao.org`.

Buying the domain or merging workflow code is not completion. Until step 6 passes, report the new as-will-be design as **not live-proven**; do not fall back to the old shared-zone design.

## How node DNS actually works (canon — read before touching anything)

For the production fleet, per-node public hosts — `<node>-test.cognidao.org` (candidate-a), `<node>-preview.cognidao.org` (preview), `<node>.cognidao.org` (prod) — are reconciled on **every flight/promote**, idempotently. The isolated test parent overrides its workload `DOMAIN` as described above, yielding `<node>.cogni-testing.org` without moving the operator endpoint:

- `scripts/ci/reconcile-node-dns.sh <env>` runs as the env-level `reconcile-dns` job in `candidate-flight.yml` (candidate-a) and `promote-and-deploy.yml` (preview/prod).
- It loops the catalog `type:node` set, derives each host via `host_for_node` (`scripts/ci/lib/image-tags.sh`), reads the env VM IP from the **operator apex** A record, and upserts `<node>-<env>` → that IP, mirroring the apex's proxy state.
- **Placement decides ownership (`PLACEMENT_OWNS_DNS`, story.5016).** It reconciles only nodes whose catalog `deployment_provider.<env>` is `k3s` (absent → `k3s`). A node placed on an external provider (`akash`) has its host **CNAME**'d to the provider by the operator's ComputeWorkload DNS reconciler — this script skips it (logged `external`, `state: external` in the Grafana summary) and `--check` stays green. Never hand-upsert an A record over one of those hosts.
- The per-node `/version` verify `needs:` it, so a node added to `infra/catalog/<node>.yaml` resolves at its public host on its **first** flight — no `*-test` wildcard, no hand-made record.
- Legacy k3s writer: `scripts/ci/lib/cloudflare-dns.sh` — refuses the zone apex / `www` unless `CF_ALLOW_PROTECTED=1`. Its `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` are env-scoped GH secrets; an env without them logs a warning and skips. Akash DNS is different: the Crossplane Composition writes with the controller's OpenBao/ESO-backed `operator-env-secrets` token and the workload's declared zone id. Do not copy that runtime token into the test repo to satisfy the skipped k3s job.
- **Single source of truth:** [`docs/spec/ci-cd.md` Axiom 21 `DNS_IS_RECONCILED_PER_ENV`](../../../docs/spec/ci-cd.md). Don't duplicate the flow — point here.

**Therefore:**

- To give a node DNS → add it to the catalog and flight it. Nothing else.
- To change where a node points → fix the **operator apex** record (below); node records follow it.
- `<node>-test` shows `NXDOMAIN` right after a flight → almost always **negative-cache** on your resolver; re-check with `dig <host> +short @1.1.1.1`. If the flight's `reconcile-dns` job was green, the record exists.

## The genuinely-manual surface

### 1. One-time Cloudflare zone setup (new fork / new domain)

Only needed when standing up a brand-new zone. Existing envs are already wired.

1. Cloudflare account → add the domain (Free plan) → set the registrar's nameservers to Cloudflare's (verify: `dig <domain> NS +short` shows cloudflare).
2. API token: **Zone · DNS · Edit** + **Zone · Zone · Read**, scoped to the specific zone. Zone ID from the dashboard → domain → API section.
3. Choose custody by writer. Legacy k3s CI keeps its token in the env-scoped GitHub environment. Akash/Crossplane keeps its token in the control environment's OpenBao operator path and exposes it only to the controller through ESO. Never seed both merely to silence a skipped job.

### 2. The env apex record (`<env>` domain + `<env>.vm.cognidao.org`)

This is the ONE record node DNS derives from — every `<node>-<env>` record inherits the apex's IP + proxy state. It is provisioned with the VM (`scripts/setup/provision-env-vm.sh`), not by `reconcile-node-dns.sh`. On a VM migration, update the apex **together with** the `VM_HOST` + `SSH_DEPLOY_KEY` GH secrets — see devops-expert's "deploy-pointer drift" rule.

### 3. Decommission a purged node's record

`reconcile-node-dns.sh` only upserts; it never prunes. When a node leaves the catalog, its `<node>-<env>` record is orphaned (harmless but stale). Remove it explicitly via the `@cogni/dns-ops` helper (enforces protected-record safety):

```typescript
import { CloudflareAdapter, removeDnsRecord } from "@cogni/dns-ops";
const cf = new CloudflareAdapter({
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  zoneId: process.env.CLOUDFLARE_ZONE_ID,
});
await removeDnsRecord(cf, "cognidao.org", "<node>-test", "A");
```

### 4. Protected-record safety (always)

**NEVER** modify `@` (zone apex), `www`, or MX records. `@cogni/dns-ops` (`upsertDnsRecord`/`removeDnsRecord`) and `cloudflare-dns.sh` enforce this — they throw `PROTECTED` / refuse without `CF_ALLOW_PROTECTED=1` (only env provisioning of the apex sets it). For these, use the Cloudflare dashboard, never CI.

## Domain ownership

**cognidao.org** — Namecheap, expires **2027-04-06** (renew annually; a 2026-04-05 lapse caused a ~6h outage). Full inventory: `work/charters/DOMAINS.md`.

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<node>-<env>` `NXDOMAIN` just after a green flight       | Negative-cache. `dig <host> +short @1.1.1.1`; flush local (`sudo dscacheutil -flushcache`). If `reconcile-dns` was green the record exists.                           |
| Born node Healthy + DNS resolves but page 000/unreachable | Not DNS — the **edge Caddy route**. Reconciled by the flight's `node-substrate` job (`reconcile-node-substrate.sh` → `reconcile-edge-caddy.remote.sh`); see ci-cd.md. |
| A node never gets a record on flight                      | Env is missing `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` (reconcile skips with a warning), OR the node isn't a catalog `type:node` with `envs:` including that env. |
| `PROTECTED: refusing to modify`                           | You targeted `@`/`www`. Use the dashboard.                                                                                                                            |
| `403` from Cloudflare                                     | Token lacks Zone · DNS · Edit. Recreate.                                                                                                                              |

> Legacy note: `packages/dns-ops/scripts/create-node.ts` creates a `<slug>.nodes.cognidao.org` formation/node-spec record — a separate, pre-Axiom-21 path, NOT the per-env app host. App-host DNS is the catalog-driven flow above; do not use create-node.ts for it.
