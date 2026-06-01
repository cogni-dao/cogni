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

Text `content` now renders as **GFM markdown** in the human UI (headings, tables, lists, `code`, links) while staying plain-text for AI search. Markdown is the shared lane — it serves both audiences from one source. `html` is the narrower escape hatch for visuals markdown can't express.

| Format               | Serves          | Use for                                                                   | `entryType`                                                                   |
| -------------------- | --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Markdown text**    | AI **+ humans** | Headings, tables, lists, code, prose. The default for nearly everything.  | `observation`, `finding`, `conclusion`, `rule`, `scorecard`, `skill`, `guide` |
| **HTML** (this spec) | humans          | SVG diagrams, charts, pill grids, freeform layout markdown can't express. | `html`                                                                        |

**Default = markdown text.** Reach for `entryType=html` only when the artifact is genuinely visual — an SVG architecture diagram, a chart, a pill/status grid that a markdown table can't carry. A scorecard, roadmap, or comparison that fits a **markdown table** stays text (and renders cleanly). A market base rate, a strategy description, a research finding — text.

Mixing is OK at the entry-set level (a domain has both kinds), never within one entry.

## Pairing a visual with its AI-readable source

An `entryType=html` block renders **human-only** — it shows in the sandboxed iframe, and an AI consumer can only read its raw markup bytes (markup is poor for search + embeddings). **There is no AI-optimized rendering of an html block.** So an html artifact must never be the _only_ home of a claim an agent needs to recall.

When a concept genuinely needs both a **simple human visual** and **detailed machine-readable text** (e.g. a spec for how something works):

- The **text/markdown atom is canonical** — full detail, pointers, source-of-truth. AI recalls this; humans read it rendered too.
- The **html atom is a derived visual face** — catchy, simplified, scannable. It carries a `citations` edge to the canonical text (`extends` / `supports` today; a dedicated `summarizes` edge is a proposed addition once ≥2 such pairs exist — don't add the type before the second use).
- **Default is still one markdown atom.** Pair only when a visual genuinely out-scans the prose _and_ the detail is worth a separate canonical row. Two atoms is a cost; pay it deliberately.

**Alignment is the citation, kept honest by review.** Because the html cites its source, drift is detectable: a periodic review walks the edge, confirms the visual still faithfully summarizes the canonical text, and raises both rows' confidence together. The html's confidence is **capped by its source** — a simplified view can't be more trustworthy than the detail it summarizes. A visual that has drifted from its source is `supersedes`-replaced, not silently edited.

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

## Expressive diagrams — the human-catchy standard

The four `.cogni-svg-*` primitives keep a diagram _correct and on-brand_; they render flat. For hero / explainer artifacts — the ones a human should land on, follow, and remember — layer in these five **token-only** patterns. Every one works in the `sandbox=""` iframe today (no new classes, no JS); they only compose raw SVG with the shipped tokens. **Canonical exemplar:** the merged `knowledge-block-two-eyes` entry (domain `meta`) — study it before authoring a new hero diagram.

| Pattern                 | What it buys                       | How (token-only)                                                                                           |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Hero gradient node**  | One focal node that _glows_        | `<linearGradient>` with two token stops at `0.30–0.55` opacity, used as the node `fill`                    |
| **Tone-coded concepts** | Each idea owns one color           | one `--chart-N` per concept — reused for its node **and** its outgoing flow, so color = meaning            |
| **Colored flow curves** | Energy + direction in the path     | bezier `<path>` stroked in the **source concept's tone** (not flat gray), `stroke-width="3"`, `marker-end` |
| **Lane washes**         | Group zones at a glance            | a large diagonal `<path>` filled with a low-opacity (`0.05→0.22`) token gradient behind each zone          |
| **Texture motifs**      | Expressive density, not decoration | faint rotated `--font-mono` glyphs + low-opacity rendered-pixel `<rect>` bars as a **background** layer    |

```svg
<defs>
  <!-- hero glow: two token stops, low opacity -->
  <linearGradient id="core" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(var(--chart-4))" stop-opacity="0.55"/>
    <stop offset="1" stop-color="hsl(var(--chart-1))" stop-opacity="0.30"/>
  </linearGradient>
  <!-- lane wash: same hue, fades across the zone -->
  <linearGradient id="wash" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="hsl(var(--chart-2))" stop-opacity="0.05"/>
    <stop offset="1" stop-color="hsl(var(--chart-2))" stop-opacity="0.22"/>
  </linearGradient>
  <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--muted-foreground))"/>
  </marker>
</defs>

<path d="M300,250 L900,40 L900,250 Z" fill="url(#wash)"/>                 <!-- lane wash -->
<rect x="120" y="232" width="200" height="80" rx="18" fill="url(#core)"   <!-- hero node -->
      stroke="hsl(var(--chart-4))" stroke-opacity="0.6" stroke-width="2"/>
<path d="M320,250 C400,210 410,150 432,118" fill="none"                   <!-- colored flow -->
      stroke="hsl(var(--chart-2))" stroke-width="3" marker-end="url(#ah)"/>
<text x="60" y="120" font-family="var(--font-mono)" font-size="22"        <!-- motif glyph -->
      fill="hsl(var(--muted-foreground))" opacity="0.45"
      transform="rotate(-12 60 120)">##</text>
```

**Type hierarchy** (the "simple clarity" half — restraint is the standard, not an afterthought):

- **Node title** — `var(--font-sans)`, weight `700`, ~16px, `hsl(var(--foreground))`.
- **Caption under title** — `var(--font-mono)`, ~11px, `hsl(var(--muted-foreground))`.
- **Zone banner** — `var(--font-sans)`, weight `700`, `letter-spacing: 3`, in the **zone's tone**.
- Whitespace beats density: **one** focal node, **≤3** flows per zone, **≤2** zones. If it needs a legend to parse, simplify until it doesn't.

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

| Rule                       | Constraint                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOKENS_ARE_THE_PALETTE     | Author content must reference `var(--token)` for colors and `var(--font-*)` for type. Hardcoded hex / named font families are anti-patterns.                                                                                                                                                                                                 |
| SANDBOX_IS_THE_BOUNDARY    | Renderer iframe stays `sandbox=""` + `referrerPolicy="no-referrer"`. Adding `allow-scripts` requires a documented threat model and a spec amendment.                                                                                                                                                                                         |
| UTILITY_LIB_IS_CAPPED      | The `.cogni-*` class set is ≤15. New classes require a spec amendment with a concrete second-artifact use case.                                                                                                                                                                                                                              |
| DIAGRAMS_USE_SVG           | Freeform flow/architecture diagrams are SVG, hand-authored, token-only fills.                                                                                                                                                                                                                                                                |
| SHELL_IS_INLINE            | The CSS shell (tokens + utilities + Charts.css) is inlined into `srcDoc` — no external `<link>` or `<script>`. Keeps artifacts portable + sandbox-safe.                                                                                                                                                                                      |
| ONE_RENDERER_FOR_ALL_NODES | Operator and future node-template forks all use the same `HtmlRenderer` + shell. Per-node theme overrides happen via the token block, not by forking the renderer.                                                                                                                                                                           |
| HTML_IS_FOR_VISUALS        | `entryType=html` is reserved for genuinely visual artifacts (SVG diagrams, charts, pill grids) markdown can't express. Ordinary human + AI content — including tables, lists, scorecards — lives in markdown text rows, which render for humans and stay searchable for AI. Authors choose format by what the content _is_, not by audience. |
| TOKEN_BLOCK_PAIRED         | Changes to `tailwind.css :root{}` / `.dark{}` and the renderer's matching token-block constants ship in the same commit until codegen lands.                                                                                                                                                                                                 |
| CATCH_THEN_CLARITY         | Hero diagrams may use gradient focal nodes, tone-coded colored flow curves, lane washes, and faint motif texture — all token-only (see "Expressive diagrams"). But one focal node, ≤2 zones, motifs stay a faint background layer. If it needs a legend to parse, simplify. Catch serves clarity; it never competes with it.                 |
| VISUAL_CITES_ITS_SOURCE    | An `entryType=html` block is human-only (AI can't read markup well), so it is never a claim's sole home. When a concept needs both a visual and machine detail, the markdown text atom is canonical and the html cites it; the html's confidence is capped by its source and re-aligned by periodic review.                                  |

## Open Questions

- A linter that validates author content against TOKENS_ARE_THE_PALETTE before write (knowledge-write tool side).
- Authoring skill (`html-knowledge-author`) that internalizes this spec — separate work item, post-implement.

## Related

- [knowledge-syntropy](./knowledge-syntropy.md) — `entryType=html` defined here
- [knowledge-data-plane](./knowledge-data-plane.md) — storage layer that holds the artifact content
- [Charts.css docs](https://chartscss.org/) — vendored library
- `knowledge-block-two-eyes` (domain `meta`) — canonical exemplar of the expressive-diagram standard
- [`contribute-to-cogni`](../../.claude/skills/contribute-to-cogni/SKILL.md) — knowledge-as-documentation-layer contract (AI-text canonical + human-html visual)
- task.5054 — agent edit-flow (separate; unrelated to styling)
