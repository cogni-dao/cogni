---
id: knowledge-html-style
type: spec
title: "Knowledge HTML Style — Authoring Contract for entryType=html Artifacts"
status: draft
spec_state: draft
trust: draft
summary: "Renderer-side design system for entryType=html knowledge entries. The renderer wraps every author payload in a shell that ships the operator app's shadcn-style CSS tokens and a tiny `.cogni-*` utility class set (~5KB total). Author content references these primitives instead of inlining its own palette, so artifacts inherit app chrome and stay consistent across nodes. Chart library deferred to v0.1."
read_when: Authoring an `entryType=html` knowledge entry, building or reviewing the html-knowledge-author skill, debugging why an artifact looks off-brand, or adding a new chart/diagram type to the cogni-utility library.
implements:
owner: derekg1729
created: 2026-05-19
verified:
tags: [knowledge, html, design-system, sandbox, shadcn]
---

# Knowledge HTML Style — Authoring Contract

> One palette, one type scale, one set of primitives. Authors write content; the renderer ships the chrome.

## Goal

Every `entryType=html` knowledge entry rendered through `HtmlRenderer` (operator `/knowledge`, future poly/node clones) looks like it belongs to the operator app — same palette, same typography, same card/pill conventions — without each author duplicating its own design language. Charts and diagrams use shared primitives, not hand-rolled palettes.

This spec defines the authoring contract: what the renderer injects, what authors are expected to use, and what counts as off-brand.

## When to Author HTML vs Text

Knowledge entries serve two audiences with opposing format pressures:

| Audience      | Optimal format                                                            | `entryType`                                                                   |
| ------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **AI agents** | Plain text. Searchable, embedding-friendly, parseable. Verbose is fine.   | `observation`, `finding`, `conclusion`, `rule`, `scorecard`, `skill`, `guide` |
| **Humans**    | Concise visual HTML. Tables, pills, diagrams, charts. Bare-minimum prose. | `html` (this spec)                                                            |

**Default = text.** Reach for `entryType=html` only when a human is the primary consumer and visual density would beat a paragraph. A design diagram, a status scorecard with N pills, a roadmap with per-quarter chart — those are `html`. A market base rate, a strategy description, a research finding — those stay text.

Mixing is OK at the entry-set level (a domain has both kinds), never within one entry.

## Non-Goals

- Interactivity. Renderer iframe is `sandbox=""` — no JavaScript runs. No clickable tabs, no live data, no DOM events. Use static SVG/CSS only.
- A full design-system port. We borrow shadcn's _visual language_ (HSL token names, radius, spacing) without importing shadcn React components.

## Design

```
┌─────────────────────────────────────────────────────────────┐
│ <iframe sandbox="" srcDoc={shell + author content}>          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <head>                                                  │ │
│  │   <style>                                               │ │
│  │     :root { --background, --foreground, --card, ... }   │ │  ← tokens
│  │     body { font-family: var(--font-sans); ... }         │ │
│  │     .cogni-card, .cogni-pill, .cogni-kv, ...            │ │  ← utilities
│  │   </style>                                              │ │
│  │ </head>                                                  │ │
│  │ <body>                                                   │ │
│  │   {author HTML}                                          │ │
│  │ </body>                                                  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

The shell is one inline `<style>` block (~5KB total) generated at render time. No external requests, no script tags, no React. Browser layout engine does everything.

## Token Drift Management

The iframe's `<style>` block can't `@import` or inherit from the parent — `sandbox=""` enforces an opaque origin. The renderer therefore **inlines snapshots** of the operator app's `:root { … }` and `.dark { … }` token blocks into the shell.

Drift discipline:

- The renderer module exports `LIGHT_TOKEN_BLOCK` and `DARK_TOKEN_BLOCK` constants containing the inlined HSL values, with `// SOURCE: nodes/operator/app/src/styles/tailwind.css …` comments pinning the authoritative origin.
- When a token in `tailwind.css` changes, the matching token-block entry MUST be updated in the same commit. PR review checks for this pair.
- A future v0.1 build script may codegen token blocks from `tailwind.css`; until then, the comment + paired-PR convention is the guard.

## Tokens (Inherited from operator app)

Authors reference these CSS variables. Hardcoded hex is an anti-pattern.

| Variable                  | Role                                 | Example use                                   |
| ------------------------- | ------------------------------------ | --------------------------------------------- |
| `--background`            | Page background                      | `body { background: hsl(var(--background)) }` |
| `--foreground`            | Body text                            | Most text                                     |
| `--card`                  | Card surface                         | `.cogni-card` background                      |
| `--card-foreground`       | Text on card                         |                                               |
| `--muted`                 | Subdued background (cells, dividers) |                                               |
| `--muted-foreground`      | Secondary text (labels, captions)    |                                               |
| `--border`                | Hairlines and outlines               |                                               |
| `--primary`               | Brand/CTA color                      | Headlines, active states                      |
| `--success`               | Positive state                       | `place` pills, ok arrows                      |
| `--warning`               | Caution state                        | `warn`, partial fills                         |
| `--destructive`           | Negative state                       | `skip`, errors                                |
| `--chart-1` … `--chart-5` | Categorical chart palette (5 hues)   | Bar/line/area series                          |
| `--font-sans`             | Body type                            | Default                                       |
| `--font-mono`             | Code / IDs / tabular data            | `.cogni-mono`                                 |
| `--radius`                | Corner radius (0.75rem)              | Cards, pills                                  |

All tokens follow shadcn convention (HSL components in the variable, `hsl(var(--x))` at use site). Exact light and dark HSL values come from `nodes/operator/app/src/styles/tailwind.css` `:root { ... }` and `.dark { ... }` blocks and are inlined verbatim into the iframe shell.

## Utility Classes (`.cogni-*`)

The complete set. ≤15 classes is a hard cap — beyond this we're rebuilding shadcn.

| Class                     | Element               | Purpose                                                                         |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `.cogni-card`             | `<div>` / `<section>` | Bordered surface with `--card` bg + `--radius` corners                          |
| `.cogni-panel-title`      | `<h2>` / `<h3>`       | Uppercase, tracked, `--muted-foreground` — section headers                      |
| `.cogni-grid`             | `<div>`               | Auto-fit grid with 16px gap (use child `grid-column` overrides)                 |
| `.cogni-divider`          | `<hr>` / `<div>`      | 1px `--border` separator                                                        |
| `.cogni-kv`               | `<div>`               | Key/value pair row (flex, `--muted-foreground` label)                           |
| `.cogni-pill`             | `<span>`              | Inline label, default neutral                                                   |
| `.cogni-pill-success`     | `<span>` (modifier)   | + green tint                                                                    |
| `.cogni-pill-warning`     | `<span>` (modifier)   | + yellow tint                                                                   |
| `.cogni-pill-destructive` | `<span>` (modifier)   | + red tint                                                                      |
| `.cogni-mono`             | any                   | Force `var(--font-mono)`                                                        |
| `.cogni-muted`            | any                   | Text in `--muted-foreground`                                                    |
| `.cogni-svg-container`    | `<rect>`              | Large rounded grouping rect — soft fill (8% alpha), 24px radius                 |
| `.cogni-svg-node`         | `<rect>`              | Themed rounded node — fill (18% alpha), 16px radius                             |
| `.cogni-svg-label`        | `<text>`              | Centered Manrope label for nodes/containers                                     |
| `.cogni-svg-arrow`        | `<line>` / `<path>`   | Connector stroke in `--muted-foreground` (dashed via inline `stroke-dasharray`) |

Both `.cogni-svg-container` and `.cogni-svg-node` read their color from a `--cogni-tone` CSS variable. Set it inline per element: `style="--cogni-tone: var(--chart-2)"`. Unset → the class defaults `--cogni-tone` to `--muted`; do not put a nested fallback inside `hsl()` because browser support is brittle in SVG paint properties. Standard tones: `--chart-1` (blue), `--chart-2` (teal), `--chart-3` (amber), `--chart-4` (violet), `--chart-5` (pink), `--color-success`, `--color-warning`, `--destructive`.

Add a class only when ≥2 existing artifacts would use it. New classes require an amendment to this spec.

## Charts — deferred to v0.1

v0 ships **no chart library**. Tokens + utility classes only (~5KB shell). Reasoning: the full [Charts.css](https://chartscss.org/) bundle is ~75KB minified — too heavy to inline into every artifact's iframe. When the first artifact genuinely needs a bar/line chart, v0.1 will either (a) ship a curated Charts.css subset (~10KB, bar+column only) or (b) provide a thin SVG bar/column helper. Until then: authors who need a chart hand-author a small SVG with token-only fills.

## Diagrams (SVG)

Diagrams compose from the four `.cogni-svg-*` primitives above. Authors set the chosen palette via the `--cogni-tone` inline variable; fills/strokes/labels inherit consistent styling.

```svg
<svg viewBox="0 0 800 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="render pipeline">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--muted-foreground))"/>
    </marker>
  </defs>

  <rect class="cogni-svg-container" style="--cogni-tone: var(--chart-4)"
        x="240" y="40" width="540" height="280"/>

  <rect class="cogni-svg-node" style="--cogni-tone: var(--chart-2)"
        x="280" y="140" width="160" height="80"/>
  <text class="cogni-svg-label" x="360" y="180">buildHtmlShell</text>

  <line class="cogni-svg-arrow" x1="200" y1="180" x2="270" y2="180" marker-end="url(#arr)"/>
</svg>
```

The `<defs>` arrowhead marker must live inside each SVG (SVG-scoped, not CSS-reachable). Other styling — fill, stroke, label typography — comes from the shipped classes.

For non-tabular freeform shapes (paths, polygons), `hsl(var(--token))` is still the rule. Hardcoded hex remains an anti-pattern.

## Anti-Patterns

| Pattern                                               | Why it's banned                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Hardcoded hex (`#0a0e0c`, `rgb(…)`)                   | Breaks `TOKENS_ARE_THE_PALETTE`. Artifact looks off-brand on theme changes.                                                   |
| `style="background: …"` with literal colors           | Same as above. Use `style="background: hsl(var(--card))"` or a `.cogni-*` class.                                              |
| Custom `@font-face` declarations                      | Pulls remote fonts (blocked by sandbox or referrer-leaks). Use `var(--font-sans)` / `var(--font-mono)`.                       |
| External `<link rel="stylesheet">` or `<script src=>` | Sandbox blocks scripts, but their presence indicates the author skipped the shell. All styling ships via the renderer.        |
| Embedded `<img src="data:…">` larger than 50KB        | Inflates the row beyond practical Dolt-diff and search-index sizes. Use SVG for diagrams, Charts.css for data viz.            |
| Inline scripts (`<script>` / `onclick=`)              | Sandbox strips them, but their presence indicates the author thought interactivity was possible. Re-read the spec.            |
| Verbose prose paragraphs                              | `entryType=html` is for visual density. Text-heavy content belongs in a text `entryType` (see "When to Author HTML vs Text"). |

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

| Rule                       | Constraint                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOKENS_ARE_THE_PALETTE     | Author content must reference `var(--token)` for colors and `var(--font-*)` for type. Hardcoded hex / named font families are anti-patterns.                                                                               |
| SANDBOX_IS_THE_BOUNDARY    | Renderer iframe stays `sandbox=""` + `referrerPolicy="no-referrer"`. Adding `allow-scripts` requires a documented threat model and a spec amendment.                                                                       |
| UTILITY_LIB_IS_CAPPED      | The `.cogni-*` class set is ≤15. New classes require a spec amendment with a concrete second-artifact use case.                                                                                                            |
| DIAGRAMS_USE_SVG           | Freeform flow/architecture diagrams are SVG, hand-authored, token-only fills.                                                                                                                                              |
| SHELL_IS_INLINE            | The CSS shell (tokens + utilities + Charts.css) is inlined into `srcDoc` — no external `<link>` or `<script>`. Keeps artifacts portable + sandbox-safe.                                                                    |
| ONE_RENDERER_FOR_ALL_NODES | Operator and future node-template forks all use the same `HtmlRenderer` + shell. Per-node theme overrides happen via the token block, not by forking the renderer.                                                         |
| HUMAN_HTML_AI_TEXT         | `entryType=html` is reserved for human-review content (concise + visual). AI-consumed knowledge (search recall, embeddings, agent reasoning) stays in text `entryType` rows. Authors choose audience first, format second. |
| TOKEN_BLOCK_PAIRED         | Changes to `tailwind.css :root{}` / `.dark{}` and the renderer's matching token-block constants ship in the same commit until codegen lands.                                                                               |

## Open Questions

- A linter that validates author content against TOKENS_ARE_THE_PALETTE before write (knowledge-write tool side).
- Authoring skill (`html-knowledge-author`) that internalizes this spec — separate work item, post-implement.

## Related

- [knowledge-syntropy](./knowledge-syntropy.md) — `entryType=html` defined here
- [knowledge-data-plane](./knowledge-data-plane.md) — storage layer that holds the artifact content
- [Charts.css docs](https://chartscss.org/) — vendored library
- task.5054 — agent edit-flow (separate; unrelated to styling)
