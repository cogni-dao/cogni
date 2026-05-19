---
id: knowledge-html-style
type: spec
title: "Knowledge HTML Style — Authoring Contract for entryType=html Artifacts"
status: draft
spec_state: draft
trust: draft
summary: "Renderer-side design system for entryType=html knowledge entries. The renderer wraps every author payload in a shell that ships (1) the operator app's shadcn-style CSS tokens, (2) a tiny `.cogni-*` utility class set, and (3) vendored Charts.css for pure-CSS data viz. Author content references these primitives instead of inlining its own palette, so artifacts inherit app chrome and stay consistent across nodes."
read_when: Authoring an `entryType=html` knowledge entry, building or reviewing the html-knowledge-author skill, debugging why an artifact looks off-brand, or adding a new chart/diagram type to the cogni-utility library.
implements:
owner: derekg1729
created: 2026-05-19
verified:
tags: [knowledge, html, design-system, sandbox, charts-css, shadcn]
---

# Knowledge HTML Style — Authoring Contract

> One palette, one type scale, one set of primitives. Authors write content; the renderer ships the chrome.

## Goal

Every `entryType=html` knowledge entry rendered through `HtmlRenderer` (operator `/knowledge`, future poly/node clones) looks like it belongs to the operator app — same palette, same typography, same card/pill conventions — without each author duplicating its own design language. Charts and diagrams use shared primitives, not hand-rolled palettes.

This spec defines the authoring contract: what the renderer injects, what authors are expected to use, and what counts as off-brand.

## Non-Goals

- Interactivity. Renderer iframe is `sandbox=""` — no JavaScript runs. No clickable tabs, no live data, no DOM events. Use static SVG/CSS only.
- A full design-system port. We borrow shadcn's *visual language* (HSL token names, radius, spacing) without importing shadcn React components.
- Theming for light mode. v0 ships dark-mode-only tokens (matches the operator's dark canvas). Light mode lands when a non-dark consumer ships.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ <iframe sandbox="" srcDoc={shell + author content}>          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <head>                                                  │ │
│  │   <style>                                               │ │
│  │     :root { --background, --foreground, --card, ... }   │ │  ← tokens
│  │     body { font-family: var(--font-sans); ... }         │ │
│  │     .cogni-card, .cogni-pill, .cogni-kv, ...            │ │  ← utilities
│  │     /* Charts.css inlined */                            │ │  ← charts
│  │   </style>                                              │ │
│  │ </head>                                                  │ │
│  │ <body>                                                   │ │
│  │   {author HTML}                                          │ │
│  │ </body>                                                  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

The shell is one inline `<style>` block (~15–20 KB total) generated at render time. No external requests, no script tags, no React. Browser layout engine does everything.

## Tokens (Inherited from operator app)

Authors reference these CSS variables. Hardcoded hex is an anti-pattern.

| Variable                  | Role                                  | Example use                                |
| ------------------------- | ------------------------------------- | ------------------------------------------ |
| `--background`            | Page background                       | `body { background: hsl(var(--background)) }` |
| `--foreground`            | Body text                             | Most text                                  |
| `--card`                  | Card surface                          | `.cogni-card` background                   |
| `--card-foreground`       | Text on card                          |                                            |
| `--muted`                 | Subdued background (cells, dividers)  |                                            |
| `--muted-foreground`      | Secondary text (labels, captions)     |                                            |
| `--border`                | Hairlines and outlines                |                                            |
| `--primary`               | Brand/CTA color                       | Headlines, active states                   |
| `--success`               | Positive state                        | `place` pills, ok arrows                   |
| `--warning`               | Caution state                         | `warn`, partial fills                      |
| `--destructive`           | Negative state                        | `skip`, errors                             |
| `--chart-1` … `--chart-5` | Categorical chart palette (5 hues)    | Bar/line/area series                       |
| `--font-sans`             | Body type                             | Default                                    |
| `--font-mono`             | Code / IDs / tabular data             | `.cogni-mono`                              |
| `--radius`                | Corner radius (0.75rem)               | Cards, pills                               |

All tokens follow shadcn convention (HSL components in the variable, `hsl(var(--x))` at use site). Exact dark-mode HSL values come from `nodes/operator/app/src/styles/tailwind.css` `.dark { ... }` block and are inlined verbatim into the iframe shell.

## Utility Classes (`.cogni-*`)

The complete set. ≤15 classes is a hard cap — beyond this we're rebuilding shadcn.

| Class                  | Element                  | Purpose                                                        |
| ---------------------- | ------------------------ | -------------------------------------------------------------- |
| `.cogni-card`          | `<div>` / `<section>`    | Bordered surface with `--card` bg + `--radius` corners         |
| `.cogni-panel-title`   | `<h2>` / `<h3>`          | Uppercase, tracked, `--muted-foreground` — section headers     |
| `.cogni-grid`          | `<div>`                  | Auto-fit grid with 16px gap (use child `grid-column` overrides) |
| `.cogni-divider`       | `<hr>` / `<div>`         | 1px `--border` separator                                       |
| `.cogni-kv`            | `<div>`                  | Key/value pair row (flex, `--muted-foreground` label)          |
| `.cogni-pill`          | `<span>`                 | Inline label, default neutral                                  |
| `.cogni-pill-success`  | `<span>` (modifier)      | + green tint                                                   |
| `.cogni-pill-warning`  | `<span>` (modifier)      | + yellow tint                                                  |
| `.cogni-pill-destructive` | `<span>` (modifier)   | + red tint                                                     |
| `.cogni-mono`          | any                      | Force `var(--font-mono)`                                       |
| `.cogni-muted`         | any                      | Text in `--muted-foreground`                                   |

Add a class only when ≥2 existing artifacts would use it. New classes require an amendment to this spec.

## Charts via Charts.css

[Charts.css](https://chartscss.org/) (MIT, ~10KB) is vendored and inlined into the iframe shell. It transforms `<table>` markup into bar / column / line / area charts using semantic HTML. **No JavaScript.**

Series colors must come from `--chart-1` … `--chart-5` (override Charts.css defaults via `--color` per-cell).

```html
<table class="charts-css bar show-labels">
  <caption>fills per hour (last 24h)</caption>
  <tbody>
    <tr>
      <th scope="row">00:00</th>
      <td style="--size: 0.3"><span class="data">3</span></td>
    </tr>
    <tr>
      <th scope="row">01:00</th>
      <td style="--size: 0.7"><span class="data">7</span></td>
    </tr>
  </tbody>
</table>
```

Supported chart types in v0: `bar`, `column`, `area`, `line`. Pie/doughnut excluded (Charts.css's pie support is limited; revisit if needed).

## Diagrams (SVG)

Hand-authored SVG is still first-class for freeform flow/pipeline diagrams (see the delta-analyzer entry). Constraints:

- Fills/strokes use `hsl(var(--token))` only — no hardcoded hex.
- Font-family inherits from the token stack (don't set on `<text>` unless using `.cogni-mono`).
- Background of the SVG canvas is transparent — the body's `--background` shows through.

A future helper script may lint authored SVGs for token compliance.

## Authoring Example

```html
<section class="cogni-card">
  <h2 class="cogni-panel-title">delta-analyzer · trading design</h2>
  <div class="cogni-grid">
    <div>
      <h3 class="cogni-panel-title">flow</h3>
      <svg viewBox="0 0 600 300" role="img">
        <!-- shapes using hsl(var(--primary)), etc. -->
      </svg>
    </div>
    <div>
      <h3 class="cogni-panel-title">legend</h3>
      <div class="cogni-kv">
        <span class="cogni-pill cogni-pill-success">place</span>
        <span class="cogni-muted">new entry</span>
      </div>
      <div class="cogni-kv">
        <span class="cogni-pill cogni-pill-destructive">skip</span>
        <span class="cogni-muted">target dominant other side</span>
      </div>
    </div>
  </div>
</section>
```

The resulting artifact uses the same chrome as the operator's own `Card`, `Badge`, `Separator` components — no per-artifact palette.

## Invariants

| Rule                            | Constraint                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOKENS_ARE_THE_PALETTE          | Author content must reference `var(--token)` for colors and `var(--font-*)` for type. Hardcoded hex / named font families are anti-patterns.                                                                                |
| SANDBOX_IS_THE_BOUNDARY         | Renderer iframe stays `sandbox=""` + `referrerPolicy="no-referrer"`. Adding `allow-scripts` requires a documented threat model and a spec amendment.                                                                        |
| UTILITY_LIB_IS_CAPPED           | The `.cogni-*` class set is ≤15. New classes require a spec amendment with a concrete second-artifact use case.                                                                                                             |
| CHARTS_USE_CHARTS_CSS           | Tabular data viz (bar / column / line / area) goes through Charts.css `<table>` markup, not bespoke SVG.                                                                                                                    |
| CHART_PALETTE_IS_TOKENIZED      | Charts.css series colors come from `--chart-1` … `--chart-5`, set via per-cell `--color` overrides.                                                                                                                          |
| DIAGRAMS_USE_SVG                | Freeform flow/architecture diagrams are SVG, hand-authored, token-only fills.                                                                                                                                                |
| SHELL_IS_INLINE                 | The CSS shell (tokens + utilities + Charts.css) is inlined into `srcDoc` — no external `<link>` or `<script>`. Keeps artifacts portable + sandbox-safe.                                                                      |
| ONE_RENDERER_FOR_ALL_NODES      | Operator and future node-template forks all use the same `HtmlRenderer` + shell. Per-node theme overrides happen via the token block, not by forking the renderer.                                                          |

## Open Questions

- Light-mode shell — defer until a light-canvas consumer ships.
- A linter that validates author content against TOKENS_ARE_THE_PALETTE before write (knowledge-write tool side).
- Authoring skill (`html-knowledge-author`) that internalizes this spec — separate work item, post-implement.

## Related

- [knowledge-syntropy](./knowledge-syntropy.md) — `entryType=html` defined here
- [knowledge-data-plane](./knowledge-data-plane.md) — storage layer that holds the artifact content
- [Charts.css docs](https://chartscss.org/) — vendored library
- task.5054 — agent edit-flow (separate; unrelated to styling)
