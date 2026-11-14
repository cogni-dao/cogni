# node-ui-kit · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Baseline UI primitive package: vendored shadcn/Radix components + reui data-grid kit + the `cn` / `useIsMobile` utilities + `HeaderFilter` (work-items column filter). Source-only exports — no `dist/`, no tsup. Consumed via `transpilePackages` in the consuming Next.js app, mirroring `@cogni/node-app`.

This is the **baseline** for `nodes/node-template/`. Forks (poly, operator, ai-only, …) may opt in or keep their own local vendor copy.

## Pointers

- [Packages Architecture › baseline UI primitive packages carve-out](https://node-template.cognidao.org/knowledge/package-isolation-rules)
- [UI Implementation › shadcn/Radix Ownership](https://node-template.cognidao.org/knowledge/frontend-development)

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

- `@cogni/node-ui-kit/shadcn` — barrel re-export of all 24 vendored shadcn primitives
- `@cogni/node-ui-kit/shadcn/<name>` — individual primitive (`button`, `card`, `dialog`, …)
- `@cogni/node-ui-kit/reui` — barrel of badge + data-grid kit
- `@cogni/node-ui-kit/reui/badge`
- `@cogni/node-ui-kit/reui/data-grid/<name>` — individual data-grid file
- `@cogni/node-ui-kit/util/cn` — `cn(...inputs)` class-name merger
- `@cogni/node-ui-kit/util/use-is-mobile` — `useIsMobile()` viewport hook
- `@cogni/node-ui-kit/header-filter` — `HeaderFilter` column-dropdown facet filter

## Standards

- **SELF_CONTAINED** — no imports from any `@/` alias or `nodes/<X>/`. Internal files use relative paths.
- **SOURCE_EXPORTS** — `package.json` exports point to `src/*.ts(x)`. Consumer must add `"@cogni/node-ui-kit"` to `transpilePackages` in `next.config.ts`.
- **PEER_DEPS_ONLY** — react, radix-ui, lucide-react, class-variance-authority, clsx, tailwind-merge, @tanstack/react-table, recharts, vaul, etc. are `peerDependencies`. The consumer brings them.
- **No tsup, no `dist/`** — Next.js handles compilation via `transpilePackages`.
- **TAILWIND_SOURCE_OWNED_BY_KIT** — Tailwind v4 only auto-scans the consuming project's tree, so the kit's classes are invisible to the compiled CSS unless declared. The kit ships `src/tailwind-source.css` that `@source`s its own files using kit-relative paths. Consumers `@import "@cogni/node-ui-kit/tailwind-source.css"` from their `tailwind.css` — no `../` traversal in consumers, no fragile coupling to the kit's filesystem location.

## Consumer integration (3 lines)

```ts
// next.config.ts
transpilePackages: ["@cogni/node-ui-kit"];
```

```jsonc
// app/package.json
"dependencies": { "@cogni/node-ui-kit": "workspace:*" }
```

```css
/* src/styles/tailwind.css */
@import "@cogni/node-ui-kit/tailwind-source.css";
```

## Responsibilities

- This directory **does**: own vendored shadcn/Radix primitives + reui data-grid + small utilities.
- This directory **does not**: ship Cogni-domain components (sign-in dialog, wallet button, work-item table). Domain UI lives in each node's `components/kit/`.

## BASELINE_READ_ONLY contract

`packages/node-ui-kit/` is a baseline. Forks **must not** modify it directly to satisfy a node-specific need. Two override patterns:

1. **Wrap and replace** — your node's `components/kit/inputs/Button.tsx` wraps `@cogni/node-ui-kit/shadcn/button` with the variant your node needs. Your barrel exports the wrapped version.

   ```ts
   // nodes/<my-fork>/app/src/components/kit/inputs/Button.tsx
   import { Button as BaseButton } from "@cogni/node-ui-kit/shadcn/button";
   import { cn } from "@cogni/node-ui-kit/util/cn";
   export function Button(props: ComponentProps<typeof BaseButton>) {
     return <BaseButton {...props} className={cn("font-display", props.className)} />;
   }
   ```

2. **Diverge entirely** — drop the dependency, keep a per-node `components/vendor/shadcn/` copy. The kit is a baseline, not a mandate; this is supported.

If you need a primitive that doesn't exist in the kit yet, **add it to the kit via a separate PR** (CODEOWNERS-gated), then wrap it in your fork. Do **not** fork the kit and modify it locally.

## Notes

- `sidebar.tsx` was originally importing the consuming node's kit `Input` and a `useIsMobile` hook. Both moved into this package (`./shadcn/input`, `./util/use-is-mobile`) so the kit is self-contained. `assistant-ui` and `shadcn-io` primitives stayed local to node-template — chat-specific or experimental, not baseline.

## Dependencies

- **Internal:** none
- **External (peer):** see `package.json` `peerDependencies`. The kit assumes the consumer's app already depends on these (every Cogni node does today).
