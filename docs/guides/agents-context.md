---
id: agents-context-guide
type: guide
title: Coding Agents & AGENTS.md
status: draft
trust: draft
summary: How to configure each coding agent (Codex, Gemini CLI, Antigravity, Claude Code, Cursor) to use AGENTS.md as single source of truth.
read_when: Setting up a new coding agent or IDE to work with this repo's AGENTS.md hierarchy.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [agents, dev, onboarding]
---

# Coding Agents & AGENTS.md

## When to Use This

You are configuring a coding agent or IDE to work with this repo. The goal is to keep one canonical set of rules (`AGENTS.md` per directory) and wire every agent to it without blowing the context window.

## Preconditions

- [ ] Repository cloned
- [ ] At least one coding agent/IDE installed (Codex, Gemini CLI, Antigravity, Claude Code, or Cursor)

## Steps

### Agent Compatibility Overview

- **Codex**: native AGENTS.md hierarchy (gold standard), dynamically loading subdirs.
- **Gemini CLI + Antigravity**: default to `GEMINI.md`, configurable to use `AGENTS.md`, but only bulk loads ALL files at boot.
- **Claude Code**: only uses `CLAUDE.md`, dynamically loading subdirs.
- **Cursor**: reads `AGENTS.md` natively.

## OpenAI Codex (CLI + IDE)

- Context: `AGENTS.md` (+ `AGENTS.override.md`).
- Load order:
  1. `~/.codex/AGENTS.md` (or `AGENTS.override.md`) – global.
  2. Repo root → current dir: nearest `AGENTS.override.md` else `AGENTS.md`.
- Config / MCP: `~/.codex/config.toml`.
  -Commands: `~/.codex/prompts/*.md`.

## Gemini CLI

- Settings: `~/.gemini/settings.json` (user), `.gemini/settings.json` (project).
- Set AGENTS as context:
  - `"contextFileName": "AGENTS.md"`.
  - Optional: `"context": { "discoveryMaxDirs": N }` to cap scans.
- Memory hierarchy: `~/.gemini/AGENTS.md` + project root + ancestor + selected subdirs.

## Antigravity IDE

- Project config directory: `.agent/` at repo root.
  - Context: `.agent/GEMINI.md` (can just say “@read AGENTS.md for rules”).
  - Workflows: `.agent/workflows/*.md` (YAML front-matter + markdown body).
  - Rules: `.agent/rules/*.md` for persistent traits that should always apply.

## Claude Code

- Context: `CLAUDE.md` in `~/.claude`, project root, and subdirs (hierarchical + on-demand).
- Bridge to AGENTS:
  - Root `CLAUDE.md`: `@./AGENTS.md` as the primary rules source.
  - Optional subdir `CLAUDE.md`: local notes + `@../AGENTS.md` or `@./AGENTS.md`.
- Commands: `.claude/commands/*.md` → `/command-name`.

## Cursor

- Context: AGENTS.md is supported directly; keep `AGENTS.md` per directory as the source of truth.
- Keep any Cursor-specific rules minimal and point back to AGENTS.md instead of duplicating policy.

### Usage Policy

- **Single source of truth**: `AGENTS.md` in each directory; no duplicated rules elsewhere.
- **Bridges only**:
  - Gemini: `contextFileName = "AGENTS.md"` + tuned `discoveryMaxDirs`.
  - Antigravity: `.agent/GEMINI.md` + workflows that explicitly reference AGENTS.md.
  - Claude / Cursor: CLAUDE.md and command files that _reference_ AGENTS.md, not copy it.

## Verification

Confirm your agent loads context correctly:

1. Start the agent in the repo root
2. Ask it to summarize the project mission — it should reference AGENTS.md content
3. Navigate to a subdirectory and verify subdir-specific context loads

## Troubleshooting

### Problem: Agent doesn't pick up AGENTS.md

**Solution:** Check the bridge configuration for your agent. Claude Code needs `CLAUDE.md` with `@./AGENTS.md`; Gemini CLI needs `"contextFileName": "AGENTS.md"` in settings.

### Problem: Agent loads too many files and blows context window

**Solution:** For Gemini CLI, tune `"discoveryMaxDirs"` in `.gemini/settings.json`. For others, keep subdir AGENTS.md files focused and concise.

## Related

- [AGENTS.md](../../AGENTS.md) — root agent instructions
- [Subdir AGENTS.md Policy](../templates/agents_subdir_template.md) — template for subdirectory AGENTS.md files
