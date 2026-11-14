# extensions · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable

## Purpose

Extension-point types and React context for node customization. Defines the `NodeAppConfig` interface that each node uses to declare its identity (navItems, externalLinks, logo).

## Pointers

- [Package AGENTS.md](../../AGENTS.md)
- [Node App Shell Spec](https://node-template.cognidao.org/knowledge/node-app-shell-contract)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": ["app", "features", "adapters", "bootstrap", "components"]
}
```

## Public Surface

- **Exports:**
  - `NodeAppConfig` — node identity and customization interface
  - `NavItem` — sidebar navigation item type
  - `ExternalLink` — sidebar footer link type
  - `NodeAppProvider` — React context provider for NodeAppConfig
  - `useNodeAppConfig()` — hook to read the current node's config
- **Env/Config keys:** none

## Responsibilities

- This directory **does**: define extension-point types; provide React context for config injection
- This directory **does not**: contain runtime logic beyond context plumbing; read env vars; own UI components

## Notes

- NodeAppConfig is the single customization surface for nodes — override via config injection, not file-path shadowing
