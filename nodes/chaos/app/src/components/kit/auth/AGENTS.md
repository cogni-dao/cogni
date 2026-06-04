# src/components/kit/auth · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek
- **Status:** stable

## Purpose

Authentication UI components. Provides the wallet connection button (RainbowKit) and sign-in dialog (wallet + OAuth options).

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [Authentication](../../../../../../docs/spec/authentication.md)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["shared"],
  "must_not_import": ["features", "core", "ports", "adapters"]
}
```

## Public Surface

- **Exports:**
  - `WalletConnectButton` - RainbowKit ConnectButton with treasury badge styling; opens SignInDialog when not connected
  - `SignInDialog` - Modal dialog presenting sign-in options (Ethereum wallet, GitHub, Google); fetches available providers from `/api/auth/providers`
- **Files considered API:** `WalletConnectButton.tsx`, `SignInDialog.tsx`

## Responsibilities

- This directory **does**: Provide UI for wallet connection via RainbowKit, sign-in dialog with wallet + OAuth options, and SIWE fallback state ("Sign message" CTA)
- This directory **does not**: Implement auth providers; handle server-side sessions; auto sign-out; perform wagmi SSR hydration

## Usage

```tsx
import { WalletConnectButton } from "@/components";

// Two instances with CSS breakpoints (Header.tsx pattern):
<WalletConnectButton variant="compact" className="sm:hidden" />
<div data-wallet-slot="desktop" className="hidden sm:flex">
  <WalletConnectButton variant="default" />
</div>
```

## Standards

- Components must be client-side ("use client")
- Sign-out is explicit user action only - no auto sign-out based on wallet state
- Follow RainbowKit best practices: global provider, explicit connect/disconnect flows

## Dependencies

- **Internal:** `@/components/kit/data-display/ProviderIcons` (SVG icons), `@/components/kit/inputs/Button`, `@/components/vendor/shadcn/dialog`
- **External:** `@rainbow-me/rainbowkit`, `next-auth/react`

## Change Protocol

- Update this file when **Public Surface** changes (new exports)
- Bump **Last reviewed** date
- Ensure new components maintain architectural boundaries

## Notes

- This directory contains the canonical wallet connection UI
- `WalletConnectButton` is designed to be used in the global header with CSS-gated instances per breakpoint
- Desktop button fills fixed shell via CSS selector `[data-wallet-slot="desktop"] button { width: 100%; height: 100%; }` (see src/styles/tailwind.css)
- Wagmi currently uses `ssr: false` + client-side skeleton gating; TODO: implement wagmi cookie-based SSR hydration for optimal stability
- Auth session is source of truth; wallet connection is ephemeral
