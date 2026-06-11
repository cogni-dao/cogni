---
name: dns-ops
description: "DNS operations for Cogni multi-node infrastructure. Node app DNS is automatic + catalog-driven (do NOT hand-set it); this skill owns the genuinely-manual surface — one-time Cloudflare zone setup, the env apex record, decommissioning a purged node's record, and protected-record safety."
---

# DNS Operations — Cogni Multi-Node

**Node app DNS is automatic, deterministic, and catalog-driven. Do NOT hand-create or `curl`-upsert per-node records.** A hand-made `<node>-<env>` record drifts from the catalog the next flight reconciles. This skill is for the _genuinely manual_ surface only: one-time Cloudflare zone setup, the env **apex** record, decommissioning a purged node, and protected-record safety.

## How node DNS actually works (canon — read before touching anything)

Per-node public hosts — `<node>-test.cognidao.org` (candidate-a), `<node>-preview.cognidao.org` (preview), `<node>.cognidao.org` (prod) — are reconciled on **every flight/promote**, idempotently:

- `scripts/ci/reconcile-node-dns.sh <env>` runs as the env-level `reconcile-dns` job in `candidate-flight.yml` (candidate-a) and `promote-and-deploy.yml` (preview/prod).
- It loops the catalog `type:node` set, derives each host via `host_for_node` (`scripts/ci/lib/image-tags.sh`), reads the env VM IP from the **operator apex** A record, and upserts `<node>-<env>` → that IP, mirroring the apex's proxy state.
- The per-node `/version` verify `needs:` it, so a node added to `infra/catalog/<node>.yaml` resolves at its public host on its **first** flight — no `*-test` wildcard, no hand-made record.
- Writer: `scripts/ci/lib/cloudflare-dns.sh` — refuses the zone apex / `www` unless `CF_ALLOW_PROTECTED=1`. `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` are env-scoped GH secrets; an env without them logs a warning and skips (its new nodes won't resolve) rather than failing the promote.
- **Single source of truth:** [`docs/spec/ci-cd.md` Axiom 21 `DNS_IS_RECONCILED_PER_ENV`](../../../docs/spec/ci-cd.md). Don't duplicate the flow — point here.

**Therefore:**

- To give a node DNS → add it to the catalog and flight it. Nothing else.
- To change where a node points → fix the **operator apex** record (below); node records follow it.
- `<node>-test` shows `NXDOMAIN` right after a flight → almost always **negative-cache** on your resolver; re-check with `dig <host> +short @1.1.1.1`. If the flight's `reconcile-dns` job was green, the record exists.

## The genuinely-manual surface

### 1. One-time Cloudflare zone setup (new fork / new domain)

Only needed when standing up a brand-new zone. Existing envs are already wired.

1. Cloudflare account → add the domain (Free plan) → set the registrar's nameservers to Cloudflare's (verify: `dig <domain> NS +short` shows cloudflare).
2. API token: **Zone · DNS · Edit**, scoped to the specific zone. Zone ID from the dashboard → domain → API section.
3. Store as the env-scoped GH secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` (not just `.env.local`) so CI's `reconcile-dns` can use them.

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
