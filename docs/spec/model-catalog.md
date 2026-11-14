---
id: model-catalog
type: spec
title: LLM Model Catalog
status: active
spec_state: active
trust: reviewed
summary: VALUE-FIRST model tiers for Cogni — DeepSeek/QwQ for thinking, Haiku/GPT-4o-Mini/Llama for agents. Reserve Opus strictly for governance.
read_when: Choosing models for agent config, updating LiteLLM or OpenClaw model lists, evaluating new models
owner: derekg1729
created: 2026-02-13
verified: 2026-02-13
tags: [ai, models, openclaw, billing]
---

# LLM Model Catalog

All models route through OpenRouter via LiteLLM proxy. The gateway agent selects models per-task; these tiers guide that selection.

## Selected Governance Models

| Tier         | Model                 | Why                                                                                    |
| ------------ | --------------------- | -------------------------------------------------------------------------------------- |
| **Thinking** | `cogni/deepseek-v3.2` | Strong reasoning, 64k context, $0.63/M total cost. VALUE FIRST: 20x cheaper than Opus. |
| **Flash**    | `cogni/llama-3.3-70b` | Incredible open-weight quality, $0.42/M total cost. Best cost/quality for agent work.  |

**Decision**: Governance runs use DeepSeek (not Opus) per COST_CRISIS_RESPONSE. Opus 4.6 is removed from routing due to bug.0060 (billing). Fallback is Kimi K2.5 (~$2/M output vs Sonnet $15/M — 7.5x cheaper, 256k context). Multi-turn OpenClaw workloads with memory_search require ≥64k context — DeepSeek meets this threshold at 1/20th the cost of premium alternatives.

## Goal

**COST CRISIS RESPONSE.** Value is now 10x more important than premium. Maintain a value-first tiered catalog: thinking tier defaults to DeepSeek ($0.25/0.38) and QwQ ($0.05/0.22), NOT Opus. Flash tier defaults to Haiku ($1/$5), GPT-4o-Mini ($0.15/$0.60), or Llama ($0.10/$0.32). Reserve Opus + Sonnet strictly for governance agent only. Both "fast" (flash) and "thinking" (reasoning) remain required, but cost discipline is non-negotiable.

## Non-Goals

- Model fine-tuning or self-hosted inference
- Automatic model rotation or A/B testing
- Per-user model preferences (single-tenant agent)

## Design

## Thinking Tier

Strong reasoning models for all file mutations: writes, edits, commits, code generation, architecture decisions, EDOs. **VALUE FIRST. ⚠️ HARD CONSTRAINT: ≥64k context minimum.** (16k empirically unusable with OpenClaw's memory_search + multi-turn overhead.) These tiers reflect 2026 pricing via OpenRouter.

| Model             | Provider  | Context | Max Out | $/M in | $/M out | ZDR | Preference  | Known Issues                                                             | Notes                                                               |
| ----------------- | --------- | ------- | ------- | ------ | ------- | --- | ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **DeepSeek-V3.2** | DeepSeek  | 64k     | 8k      | $0.25  | $0.38   | No  | 🎯 DEFAULT  | None                                                                     | THE PRIMARY CHOICE. 64k context (minimum viable), strong reasoning. |
| Claude Sonnet 4.5 | Anthropic | 200k    | 4k      | $3.00  | $15.00  | Yes | ❌ No       | Too expensive ($15/M output); use Kimi K2.5 instead.                     | Removed from governance tier; too costly.                           |
| Claude Opus 4.6   | Anthropic | 1M      | 128k    | $5.00  | $25.00  | Yes | ❌ Removed  | **bug.0060:** LiteLLM `response_cost=$0` for OpenRouter. Breaks billing. | Removed from routing. Use Sonnet 4.5 instead.                       |
| QwQ-32B           | Qwen      | 16k     | —       | $0.05  | $0.22   | No  | ❌ No       | Context too small (16k < 64k minimum).                                   | Unusable for multi-turn OpenClaw workloads.                         |
| Kimi K2 Thinking  | Moonshot  | 256k    | 65k     | $0.60  | $2.50   | No  | Strong      | None                                                                     | Advanced MoE reasoning. Multi-turn agentic workflows.               |
| Kimi K2.5         | Moonshot  | 256k    | 65k     | ~$0.50 | ~$2.00  | No  | 🎯 FALLBACK | None                                                                     | Fallback thinking model: 7.5x cheaper than Sonnet, 256k context.    |

## Flash Tier

Fast, cheap models for read-only subagent work: scanning, grep-and-summarize, data extraction, synthesis, research. No file mutations. **Optimized for ultra-low cost at scale — these are primary agents.**

| Model                  | Provider  | Context | Max Out | $/M in | $/M out | ZDR | Preference  | Known Issues | Notes                                                                  |
| ---------------------- | --------- | ------- | ------- | ------ | ------- | --- | ----------- | ------------ | ---------------------------------------------------------------------- |
| **Llama 3.3 70B**      | Meta      | 128k    | 8k      | $0.10  | $0.32   | No  | 🎯 USE THIS | None         | Incredible for open-weight. Strong coding. $0.42/M total cost.         |
| **GPT-4o Mini**        | OpenAI    | 128k    | 16k     | $0.15  | $0.60   | No  | 🎯 USE THIS | None         | Ultra-cheap + capable. Best cost/quality ratio. $0.75/M total cost.    |
| **Claude Haiku 4.5**   | Anthropic | 200k    | 4k      | $1.00  | $5.00   | Yes | Strong      | None         | Premium if budget allows. 2× speed of 3.5, matches Sonnet 4 on coding. |
| Qwen3 Coder 480B       | Qwen      | 128k    | 8k      | ~$0.20 | ~$0.40  | No  | Value       | None         | Specializes in coding. Competitive with GPT-4o mini.                   |
| Gemini 2.5 Flash Lite  | Google    | 1M      | 8k      | ~$0.15 | ~$1.00  | Yes | Value       | None         | Lighter version of 2.5 Flash. Good for high-volume scanning.           |
| Gemini 2.5 Flash       | Google    | 1M      | 8k      | $0.30  | $2.50   | Yes | Strong      | None         | Excellent balance. 1M context, built-in thinking, strong reasoning.    |
| Mistral Large (latest) | Mistral   | 128k    | 4k      | ~$0.27 | ~$0.81  | No  | Value       | None         | Multimodal capable, solid all-rounder.                                 |
| Llama 3.3 70B (free)   | Meta      | 128k    | 8k      | $0     | $0      | No  | Free (dev)  | Rate-limited | Rate-limited (~1k req/day) but viable for local dev/testing only.      |

## Free Tier

Zero-cost models for development, testing, and low-priority tasks. ⚠️ **Severely rate-limited (typically ~1,000 requests/day with credits)** — unusable for OpenClaw workloads due to high per-call token volume and multi-turn conversation overhead.

| Model             | Provider | Context | Tool Use | Notes              |
| ----------------- | -------- | ------- | -------- | ------------------ |
| Nemotron Nano 30B | NVIDIA   | 256k    | Yes      | Default free model |
| TNG Chimera       | TNG      | 163k    | Yes      | Reasoning-capable  |
| Trinity Mini      | Arcee    | 131k    | Yes      | —                  |
| Solar Pro 3       | Upstage  | 128k    | Yes      | —                  |
| GLM 4.5 Air       | Zhipu    | 131k    | Yes      | —                  |

## Config Mapping

| LiteLLM alias       | OpenRouter ID                                  | Gateway catalog ID        | Tier  |
| ------------------- | ---------------------------------------------- | ------------------------- | ----- |
| `claude-opus-4.6`   | `openrouter/anthropic/claude-opus-4-6`         | `cogni/claude-opus-4.6`   | Think |
| `claude-sonnet-4.5` | `openrouter/anthropic/claude-sonnet-4.5`       | `cogni/claude-sonnet-4.5` | Think |
| `claude-haiku-4.5`  | `openrouter/anthropic/claude-haiku-4.5`        | `cogni/claude-haiku-4.5`  | Flash |
| `deepseek-v3.2`     | `openrouter/deepseek/deepseek-chat-v3.2`       | `cogni/deepseek-v3.2`     | Think |
| `qwq-32b`           | `openrouter/qwen/qwq-32b`                      | `cogni/qwq-32b`           | Think |
| `kimi-k2-thinking`  | `openrouter/moonshotai/kimi-k2-thinking`       | `cogni/kimi-k2-thinking`  | Think |
| `gemini-2.5-flash`  | `openrouter/google/gemini-2.5-flash`           | `cogni/gemini-2.5-flash`  | Flash |
| `gpt-4o-mini`       | `openrouter/openai/gpt-4o-mini`                | `cogni/gpt-4o-mini`       | Flash |
| `llama-3.3-70b`     | `openrouter/meta-llama/llama-3.3-70b-instruct` | `cogni/llama-3.3-70b`     | Flash |
| `qwen3-coder-480b`  | `openrouter/qwen/qwen3-coder`                  | `cogni/qwen3-coder-480b`  | Flash |

## Current Defaults

```
🎯 DEFAULT THINKING:  cogni/deepseek-v3.2        (64k context, $0.63/M total, strong reasoning)
   Fallback thinking:  cogni/claude-sonnet-4.5   (if DeepSeek insufficient, governance use only)
   Governance agent:   cogni/claude-opus-4.6     (frontier reasoning for governance + arbitration)

🎯 DEFAULT AGENTS:    cogni/llama-3.3-70b        (128k context, $0.42/M total, best value)
   Alt agent (fast):   cogni/gpt-4o-mini         (128k context, $0.75/M total, more capable)
   Premium agent:      cogni/claude-haiku-4.5    (200k context, $6/M total, real-time coding)
```

## Invariants

| Rule                  | Constraint                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| COST_CRISIS           | **#1 PRIORITY.** Value is 10x more important than premium. Default to DeepSeek ($0.25/0.38) for thinking, Llama for agents. |
| CONTEXT_MINIMUM_64K   | Thinking tier: ≥64k context minimum (16k is empirically unusable with OpenClaw multi-turn). Flash: ≥128k preferred.         |
| NO_OPUS_AGENTS        | Opus 4.6 reserved for governance only. Ban Opus from subagents, research, loops. Use DeepSeek/Sonnet instead.               |
| WRITES_REQUIRE_STRONG | All file mutations use thinking-tier models (DeepSeek/Sonnet/Opus). Flash models read-only.                                 |
| MODELS_VIA_PROXY      | All LLM calls route through LiteLLM proxy. No direct provider API calls from agents.                                        |
| REASONING_EXPLICIT    | Enable reasoning/thinking modes only when task genuinely requires step-by-step analysis. Disable by default to save tokens. |

## Evaluation Criteria

When evaluating new models for this catalog:

1. **Tool use support** — must support function calling via OpenRouter
2. **Context window** — prefer ≥200k for thinking, ≥128k for flash
3. **Reasoning** — thinking tier must support extended thinking / configurable reasoning depth
4. **ZDR (Zero Data Retention)** — prefer providers that support it (Anthropic, Google)
5. **Cost** — thinking tier ≤$30/M output, flash tier ≤$5/M output, free tier = $0
6. **Streaming** — must support streaming responses

## Related

- [LiteLLM config](../../infra/compose/configs/litellm.config.yaml) — proxy routing
- [openclaw-gateway.json](../../services/sandbox-openclaw/openclaw-gateway.json) — agent model catalog
- [external-executor-billing](./external-executor-billing.md) — billing reconciliation
- [openclaw-subagents](./openclaw-subagents.md) — subagent model tier strategy
