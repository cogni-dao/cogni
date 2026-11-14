# node-app · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable

## Purpose

Internal source package providing the Cogni node platform: auth/query/wallet providers and extension-point types (NodeAppConfig). Compiled by each consumer's bundler via `transpilePackages` — no `dist/` build step.

## Pointers

- [Node App Shell Spec](https://node-template.cognidao.org/knowledge/node-app-shell-contract)
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "adapters",
    "bootstrap",
    "components",
    "services"
  ]
}
```

## Public Surface

- **Exports:**
  - `@cogni/node-app/providers` — `AppProviders`, `AuthProvider`, `QueryProvider`, `WalletProvider`, `createAppLightTheme`, `createAppDarkTheme`
  - `@cogni/node-app/extensions` — `NodeAppConfig`, `NavItem`, `ExternalLink`, `NodeAppProvider`, `useNodeAppConfig`
- **Env/Config keys:** none (SHELL_NEVER_READS_ENV)

## Responsibilities

- This directory **does**: provide platform providers (auth, query, wallet), extension-point types, and React context for node config injection
- This directory **does not**: read env vars, own layout components, own routes, import from `@/` app aliases

## Standards

- Source exports only — no tsup, no `dist/` in package.json exports
- Curated subpath exports (`"./providers"`, `"./extensions"`) — no wildcards
- `transpilePackages: ["@cogni/node-app"]` required in every consuming next.config.ts
- WalletProvider accepts wagmiConfig as prop — node-local chain config stays node-owned

## Notes

- Layout extraction consciously deferred — sidebar/header depend on shadcn vendor primitives. NodeAppConfig extension points are the prep work for that follow-up.

## Dependencies

- **Internal:** none
- **External (peer):** react, next-auth, next-themes, @tanstack/react-query, @rainbow-me/rainbowkit, @rainbow-me/rainbowkit-siwe-next-auth, wagmi
