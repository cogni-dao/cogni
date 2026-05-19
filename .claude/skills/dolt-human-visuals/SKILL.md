---
name: dolt-human-visuals
description: Use whenever authoring a Cogni knowledge entry whose primary consumer is a HUMAN reviewing it visually (design diagrams, status scorecards, roadmaps, PR review summaries, anything where a paragraph would lose to a picture). Routes the author away from text-heavy AI-optimized entry types toward `entryType: html` per docs/spec/knowledge-html-style.md — concise, visual, sandbox-safe HTML built from the operator app's tokens and the `.cogni-*` utility classes. Trigger when posting to /api/v1/knowledge/contributions and the content is for human review.
---

# dolt-human-visuals

> AI consumers read text. Humans read pictures. Match the medium to the audience.

## The principle

Knowledge entries serve two audiences:

- **AI agents** — recall, embeddings, reasoning → text is right. Use `observation`, `finding`, `conclusion`, `rule`, `scorecard`, `skill`, `guide`.
- **Humans** — review, approve, scan → HTML is right. Use `entryType: "html"`. Concise. Visual. Bare-minimum prose.

If you're writing prose for a human to read, stop. Convert to:

- A `<table>` of facts
- A `.cogni-card` per claim
- A row of `.cogni-pill` status indicators
- An SVG diagram

## Authoring contract

Full rules: [`docs/spec/knowledge-html-style.md`](../../../docs/spec/knowledge-html-style.md).

### Must

- Reference tokens, never hex: `hsl(var(--card))`, `hsl(var(--muted-foreground))`, `hsl(var(--color-success))`
- Use `.cogni-card`, `.cogni-panel-title`, `.cogni-grid`, `.cogni-kv`, `.cogni-pill[-success/-warning/-destructive]`, `.cogni-mono`, `.cogni-muted`, `.cogni-divider`
- For SVG diagrams, compose from `.cogni-svg-container`, `.cogni-svg-node`, `.cogni-svg-label`, `.cogni-svg-arrow`; set per-shape tone with `style="--cogni-tone: var(--chart-2)"`
- Fonts: `var(--font-sans)` or `var(--font-mono)` only
- SVG diagrams: token-only fills; transparent canvas

### Must not

- `<script>`, `<form>`, `<iframe>`, `onclick=`, inline JS
- Custom `@font-face`, external `<link>` or `<script src=>`
- Hardcoded hex / rgb / named colors
- `<img src="data:…">` larger than 50KB
- Paragraphs where a pill + value would do

## Minimal authoring template

```html
<section class="cogni-card">
  <h2 class="cogni-panel-title">{title}</h2>
  <div class="cogni-grid">
    <div>
      <h3 class="cogni-panel-title">{section}</h3>
      <div class="cogni-kv">
        <span class="cogni-pill cogni-pill-success">{state}</span>
        <span class="cogni-muted">{detail}</span>
      </div>
    </div>
  </div>
</section>
```

## Posting

```bash
curl -X POST "$NODE_URL/api/v1/knowledge/contributions" \
  -H "Authorization: Bearer $COGNI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "<one-line intent>",
    "entries": [{
      "domain": "<registered-domain>",
      "title": "<short human title>",
      "content": "<HTML body fragment using .cogni-* classes>",
      "entryType": "html"
    }]
  }'
```

The contribution lands in the operator's `/knowledge?mode=inbox` for human review. The reviewer sees the artifact rendered inline beneath the title — they merge if it looks right.

## When not to use this skill

- Content is for AI consumption (recall / embeddings / agent reasoning) → use a text `entryType`
- Content fits in one sentence → use `entryType: "finding"` with plain text
- You need interactivity (clicks, live data) → out of scope; v0 sandbox is no-JS
