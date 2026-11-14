# dns-ops · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** draft

## Purpose

Programmatic DNS management for Cogni multi-node infrastructure. Provides a port-based abstraction over DNS providers (Cloudflare, Namecheap) with safety guards that prevent modification of production records.

## Pointers

- [Cloudflare Setup Guide](https://cognidao.org/knowledge/node-dns-operations)
- [dns-ops skill](../../.claude/skills/dns-ops/SKILL.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

## Public Surface

- **Exports** (`src/index.ts`):
  - Types: `DomainRegistrarPort`, `TargetedDnsPort`, `DnsRecord`, `DnsRecordType`, `DomainAvailability`, `NamecheapCredentials`, `CloudflareCredentials`, `RegistrantContact`, `RegistrationResult`
  - Classes: `CloudflareAdapter`, `NamecheapAdapter`
  - Functions: `splitDomain`, `upsertDnsRecord`, `removeDnsRecord`
- **Files considered API:** `src/index.ts`, `src/port/*.ts`, `src/domain/types.ts`

## Ports

- **Defines ports:** `DomainRegistrarPort` (base), `TargetedDnsPort` (extended, Cloudflare-style)
- **Implements ports:** `CloudflareAdapter` (both ports), `NamecheapAdapter` (base only)

## Responsibilities

- This directory **does**: DNS record CRUD, domain availability checks, domain registration, read-modify-write safety, protected record enforcement
- This directory **does not**: access `process.env`, manage TLS certificates, provision infrastructure, interact with databases

## Usage

```bash
pnpm --filter @cogni/dns-ops typecheck    # type check
pnpm --filter @cogni/dns-ops build        # build to dist/
pnpm vitest run packages/dns-ops/tests/   # run 31 unit tests

# CLI scripts (require CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID in env)
npx tsx packages/dns-ops/scripts/create-node.ts <slug>
npx tsx packages/dns-ops/scripts/test-live.ts
```

## Standards

- **PURE_LIBRARY**: No `process.env` access. Credentials passed via constructor.
- **PROTECTED_RECORDS**: `@` and `www` records blocked from programmatic modification.
- **READ_MODIFY_WRITE**: `setDnsRecords` replaces ALL records. Always use helpers (`upsertDnsRecord`/`removeDnsRecord`) for safe targeted changes.

## Dependencies

- **Internal:** none
- **External:** `fast-xml-parser` (Namecheap XML parsing)

## Notes

- Cloudflare adapter is the primary path (free API, JSON, instant). Namecheap adapter exists for domain registration (requires $50 spend for API access).
- `setDnsRecords` on Cloudflare is non-atomic (delete-all then create-all). Always prefer the targeted methods (`createRecord`/`updateRecord`/`deleteRecord`) via `upsertDnsRecord`/`removeDnsRecord` helpers.

## Change Protocol

When public surface changes: update this AGENTS.md, update `src/index.ts` exports, update the hub guide [`node-dns-operations`](https://cognidao.org/knowledge/node-dns-operations) through a knowledge contribution.
