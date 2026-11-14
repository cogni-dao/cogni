# providers · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** stable

## Purpose

Client-side provider composition for the Cogni node platform. Configures React context providers (NextAuth SessionProvider, wagmi, RainbowKit, React Query) shared across all node apps.

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
  - `AppProviders` — composition of all providers; accepts `wagmiConfig` prop
  - `AuthProvider` — NextAuth SessionProvider wrapper
  - `QueryProvider` — React Query client provider
  - `WalletProvider` — wagmi + RainbowKit provider; accepts `wagmiConfig` prop
  - `createAppLightTheme`, `createAppDarkTheme` — RainbowKit theme factories
- **Env/Config keys:** none

## Responsibilities

- This directory **does**: compose client-side React providers; configure RainbowKit theme; export pure config builder helpers
- This directory **does not**: read env vars; import wagmiConfig (accepts as prop); contain business logic

## Notes

- Provider order matters: AuthProvider → QueryProvider → WalletProvider
- WalletProvider uses static config with SSR support (cookieStorage)
- RainbowKitThemeProvider nested inside WalletProvider to isolate theme changes
