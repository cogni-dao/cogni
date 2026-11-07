---
name: dns-ops
description: "DNS operations for Cogni multi-node infrastructure. Node app DNS is automatic + catalog-driven (do NOT hand-set it); this skill owns DNS trust boundaries, one-time Cloudflare zone setup, the env apex record, decommissioning a purged node's record, and protected-record safety. Use it whenever a test fleet, Akash workload, Cloudflare token, domain, zone, or node hostname is being created or changed."
---

# DNS Operations — Cogni Multi-Node

**Node app DNS is automatic, deterministic, and catalog-driven. Do NOT hand-create or `curl`-upsert per-node records.** A hand-made `<node>-<env>` record drifts from the catalog the next flight reconciles. This skill is for the _genuinely manual_ surface only: one-time Cloudflare zone setup, the env **apex** record, decommissioning a purged node, and protected-record safety.

## Test-fleet DNS boundary

> **Live since story.5137.** `cogni-testing.org` was acquired and delegated on 2026-09-22. Test nodes ship through the deploy verb on the test operator, and `https://spawny-boi-test.cogni-testing.org/version` answers 200.

The candidate operator and disposable test workloads intentionally use different DNS zones:

| Concern                             | Canonical value                                                             | Authority                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| candidate operator/control endpoint | `test.cognidao.org`                                                         | production `cognidao.org` zone; do not move it                                                            |
| test-org Akash workload             | `<node>-test.cogni-testing.org` (candidate-a)                               | isolated `cogni-testing.org` zone                                                                         |
| workload public-domain input        | `NODE_DEPLOY_WORKLOAD_ZONE=cogni-testing.org` on the test operator          | operator config; no `DOMAIN` fallback                                                                     |
| shared substrate root               | `FORK_DOMAIN_ROOT=cognidao.org` (or its existing default)                   | names candidate-a's VM services; it is **not** the workload DNS zone                                      |
| DNS zone id                         | `cogni-testing.org` zone id                                                 | public identifier; the sequencer finds it by zone name at boot                                            |
| DNS writer credential               | token scoped only to `cogni-testing.org`                                    | candidate-a OpenBao `cogni/candidate-a/operator/CLOUDFLARE_API_TOKEN` → ESO `operator-env-secrets`        |

Cloudflare API-token permissions are zone-wide; they cannot be restricted to a record prefix. Therefore a test-fleet token for the `cognidao.org` zone is not isolated, even if an agent promises to write only `*-test` records. Never put the production-zone token, VM SSH key, or any other production credential in `cogni-test-org`.

The test GitHub App is deliberately broad inside `cogni-test-org`. That makes this boundary load-bearing: test-controlled desired state may choose a hostname or zone id, but the controller's token can mutate only `cogni-testing.org`.

### Bring `cogni-testing.org` online once

1. Add `cogni-testing.org` to Cloudflare and replace the registrar nameservers with the two Cloudflare nameservers. Verify delegation with `dig cogni-testing.org NS +short`.
2. In Cloudflare, set SSL/TLS encryption mode to **Full**. Akash workload records are proxied; do not grant settings-write merely to automate this one-time click.
3. Create a token with `Zone · DNS · Edit` and `Zone · Zone · Read`, restricted to the single `cogni-testing.org` zone.
4. Give the token to the secrets-manager lane, which writes it to candidate-a OpenBao and forces ESO refresh. Do not paste it into chat, a file, a PR, or GitHub Actions.
5. Set the test operator input `NODE_DEPLOY_WORKLOAD_ZONE=cogni-testing.org`. The sequencer finds the zone id by name, so no zone id input is needed.
6. Prove the boundary with one disposable Akash node. Green means its candidate-a host is `<node>-test.cogni-testing.org`, DNS exists in only that zone, `/version` returns the expected SHA, and the old-SHA → new-SHA probe has zero DNS/TLS/HTTP failures.

Do not create an apex/VM record for this Akash-only workload zone. The node-deploy sequencer creates each workload host record from the provider endpoint. The candidate operator and shared substrate keep their existing records under `cognidao.org`.

Buying the domain or merging code is not completion; step 6 is. spawny-boi passed it (story.5137). Re-run step 6 after any change to this boundary, and never fall back to the old shared-zone design.

## How node DNS actually works (canon — read before touching anything)

For the production fleet, per-node public hosts — `<node>-test.cognidao.org` (candidate-a), `<node>-preview.cognidao.org` (preview), `<node>.cognidao.org` (prod) — are reconciled on **every flight/promote**, idempotently. The isolated test operator sets `NODE_DEPLOY_WORKLOAD_ZONE=cogni-testing.org` as described above, yielding `<node>-test.cogni-testing.org` without moving the operator endpoint:

- **The deploy verb owns node hosts.** `POST /api/v1/deploy/workloads` makes the node-deploy sequencer move the proxied Cloudflare edge for the node host to the new lease. It moves only after 8 public reads in a row show the exact commit. The old lease keeps serving until then. See [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload). Never hand-upsert a record over a node host.
- The host must be the node's own host. The workload manifest declares the production host. Other environments use a sibling (`-test`, `-preview`). The sequencer refuses another node's host (`edge_host_refused`).
- The sequencer writes with the control environment's OpenBao/ESO-backed `operator-env-secrets` token and the zone id it finds by zone name at boot. Do not copy that runtime token into the test repo.
- **Operator only:** `scripts/ci/reconcile-node-dns.sh <env>` and `scripts/ci/lib/cloudflare-dns.sh` serve the operator's own k3s hosts. `cloudflare-dns.sh` refuses the zone apex and `www` unless `CF_ALLOW_PROTECTED=1`. Its `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are env-scoped GH secrets.
- **Single source of truth:** [`docs/spec/ci-cd.md` Axiom 21 `DNS_IS_RECONCILED_PER_ENV`](../../../docs/spec/ci-cd.md). Don't duplicate the flow — point here.

**Therefore:**

- To give a node DNS → add it to the catalog and flight it. Nothing else.
- To change where a node points → fix the **operator apex** record (below); node records follow it.
- `<node>-test` shows `NXDOMAIN` right after a release → almost always **negative-cache** on your resolver; re-check with `dig <host> +short @1.1.1.1`. If the release logged `edge_moved`, the record exists.

## The genuinely-manual surface

### 1. One-time Cloudflare zone setup (new fork / new domain)

Only needed when standing up a brand-new zone. Existing envs are already wired.

1. Cloudflare account → add the domain (Free plan) → set the registrar's nameservers to Cloudflare's (verify: `dig <domain> NS +short` shows cloudflare).
2. API token: **Zone · DNS · Edit** + **Zone · Zone · Read**, scoped to the specific zone. Zone ID from the dashboard → domain → API section.
3. Choose custody by writer. Operator k3s CI keeps its token in the env-scoped GitHub environment. The node-deploy sequencer keeps its token in the control environment's OpenBao operator path and exposes it only to the operator through ESO. Never seed both merely to silence a skipped job.

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
| `<node>-<env>` `NXDOMAIN` just after a release            | Negative-cache. `dig <host> +short @1.1.1.1`; flush local (`sudo dscacheutil -flushcache`). If the release logged `edge_moved`, the record exists.                   |
| Born node Healthy + DNS resolves but page 000/unreachable | Not DNS — the **edge Caddy route**. Reconciled by the flight's `node-substrate` job (`reconcile-node-substrate.sh` → `reconcile-edge-caddy.remote.sh`); see ci-cd.md. |
| A node never gets a record on flight                      | Env is missing `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` (reconcile skips with a warning), OR the node isn't a catalog `type:node` with `envs:` including that env. |
| `PROTECTED: refusing to modify`                           | You targeted `@`/`www`. Use the dashboard.                                                                                                                            |
| `403` from Cloudflare                                     | Token lacks Zone · DNS · Edit. Recreate.                                                                                                                              |

> Legacy note: `packages/dns-ops/scripts/create-node.ts` creates a `<slug>.nodes.cognidao.org` formation/node-spec record — a separate, pre-Axiom-21 path, NOT the per-env app host. App-host DNS is the catalog-driven flow above; do not use create-node.ts for it.
