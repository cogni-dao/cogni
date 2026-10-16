---
id: proj.agentic-interop
type: project
primary_charter: chr.engineering
title: Agentic Interoperability — MCP Server, Agent Identity, A2A Discovery
state: Active
priority: 1
estimate: 5
summary: Make Cogni agents addressable, authenticated, and interoperable on the emerging agentic internet via MCP server, OAuth agent identity, and A2A agent cards
outcome: Cogni agents expose tools via MCP, authenticate via OAuth 2.1, and are discoverable via A2A-compatible agent cards
assignees:
  - cogni-dev
created: 2026-02-22
updated: 2026-03-30
labels:
  - ai-graphs
  - tooling
  - identity
  - interop
---

# Agentic Interoperability — MCP Server, Agent Identity, A2A Discovery

> Source: [docs/research/agentic-internet-gap-analysis.md](../../docs/research/agentic-internet-gap-analysis.md)

## Goal

Make Cogni agents first-class participants in the agentic internet. Today, our agents are only reachable through the web UI and Discord. The industry has converged on MCP (agent↔tools), A2A (agent↔agent), and OAuth 2.1 as the interoperability stack. This project delivers the protocol surface to participate.

**Non-goals:**

- x402 payment integration (x402 doesn't support streaming token billing — our primary cost center; evaluate when protocol matures)
- Autonomous decision-making (stays in `proj.governance-agents`)
- General container hosting (MCP scope: approved server templates only, not a Heroku clone)

## Context

As of Feb 2026, the agentic internet is crystallizing around:

- **MCP**: 97M monthly SDK downloads, 10K+ servers, first-class in ChatGPT/Claude/Cursor/Gemini/Copilot/VS Code
- **A2A**: Google's agent-to-agent protocol under Linux Foundation, uses "agent cards" for discovery
- **OAuth 2.1 + PKCE**: MCP Authorization Spec standard for resource access
- **NIST**: AI Agent Standards Initiative (Feb 17), Identity & Authorization paper (Feb 5)

We have: hexagonal architecture (57 boundary tests), tool catalog with 6 tools, `AgentCatalogPort` (discovery P0 done), identity bindings, execution grants. We lack: MCP server (stub only), agent OAuth, A2A compatibility, external tool consumption.

## Roadmap

### Crawl (P0): MCP Server — Become Addressable

**Goal:** Expose Cogni tools via MCP so external agents and clients can discover and invoke them.

**Prerequisite:** `proj.tool-use-evolution` P0 is mostly Done (semantic types, tool policy, ToolSourcePort). Remaining P0 items (connection auth, RBAC wiring) are parallel, not blocking.

| Deliverable                                                                            | Status      | Est | Work Item |
| -------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Implement `createMCPServer()` in `src/mcp/server.ts` using `@modelcontextprotocol/sdk` | Not Started | 2   | —         |
| Auto-register MCP tools from `TOOL_CATALOG` via `ToolSourcePort.listToolSpecs()`       | Not Started | 1   | —         |
| Map `ToolSpec` → MCP tool schema (name, description, inputSchema as JSONSchema7)       | Not Started | 1   | —         |
| MCP `tools/list` endpoint returns all enabled tools                                    | Not Started | 1   | —         |
| MCP `tools/call` delegates to `toolRunner.exec()` (reuses existing policy pipeline)    | Not Started | 1   | —         |
| Transport: stdio for local dev, SSE/streamable-HTTP for remote                         | Not Started | 1   | —         |
| MCP tool ID format: `mcp:cogni:<toolName>` (namespaced per `proj.tool-use-evolution`)  | Not Started | 0   | —         |
| Integration test: external MCP client discovers and calls `get-current-time`           | Not Started | 1   | —         |
| `tools/list_changed` notification when catalog changes                                 | Not Started | 1   | —         |
| Documentation: MCP server setup and tool catalog                                       | Not Started | 1   | —         |

**Auth (P0.1):**

| Deliverable                                                                     | Status      | Est | Work Item |
| ------------------------------------------------------------------------------- | ----------- | --- | --------- |
| OAuth 2.1 + PKCE flow for MCP resource access (per MCP auth spec)               | Not Started | 2   | —         |
| Map OAuth token → `ActorId` for `ToolInvocationContext`                         | Not Started | 1   | —         |
| Rate limiting per authenticated client                                          | Not Started | 1   | —         |
| Deny unauthenticated access by default (align with MCP security audit findings) | Not Started | 0   | —         |
| Test: unauthenticated client gets 401, not tool list                            | Not Started | 1   | —         |

### Walk (P1): Agent Cards + MCP Client — Become Interoperable

**Goal:** Agents are discoverable via A2A-compatible agent cards and can consume external MCP servers.

**Depends on:** `proj.agent-registry` Identity Track P0 (AgentRegistrationDocument, AgentIdentityPort), `proj.tenant-connections` P1 (OAuth credential brokering)

**Agent Cards (outbound discovery):**

| Deliverable                                                     | Status      | Est | Work Item |
| --------------------------------------------------------------- | ----------- | --- | --------- |
| Publish `.well-known/agent.json` per A2A agent card spec        | Not Started | 1   | —         |
| Map `AgentRegistrationDocument` → A2A agent card fields         | Not Started | 1   | —         |
| Include MCP server endpoint in agent card `services[]`          | Not Started | 0   | —         |
| Agent card includes `capabilities` derived from enabled tools   | Not Started | 1   | —         |
| Test: A2A client resolves agent card and discovers MCP endpoint | Not Started | 1   | —         |

**MCP Client (inbound tool consumption):**

| Deliverable                                                                     | Status      | Est | Work Item |
| ------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Create `McpToolSource` implementing `ToolSourcePort`                            | Done        | 2   | task.0228 |
| MCP tool discovery via `tools/list` on configured external servers              | Done        | 1   | task.0228 |
| `MCP_UNTRUSTED_BY_DEFAULT`: discovered tools require explicit policy enablement | Done        | 1   | task.0228 |
| MCP as Docker Compose services (Streamable HTTP, reconnect-on-error)            | Done        | 2   | task.0228 |
| Playwright + Grafana MCP servers running in dev stack                           | Done        | 1   | task.0228 |
| Handle `tools/list_changed`: refresh catalog, keep policy unchanged             | Not Started | 1   | —         |
| Credential brokering via `ConnectionBrokerPort` for MCP server tokens           | Not Started | 1   | —         |
| Test: agent discovers external MCP tool, policy enables it, agent invokes it    | Not Started | 1   | —         |

**MCP Control Plane (deployment registry + multi-tenant):**

See [mcp-control-plane.md](../../docs/spec/mcp-control-plane.md) for full spec.

| Deliverable                                                        | Status      | Est | Work Item |
| ------------------------------------------------------------------ | ----------- | --- | --------- |
| Phase 0.5: MCP services in prod compose + `MCP_SERVERS` env var    | Not Started | 0   | —         |
| Phase 1: `mcp_deployments` + `agent_mcp_bindings` tables           | Not Started | 3   | —         |
| Phase 1: Auth headers via ConnectionBrokerPort at connect time     | Not Started | 2   | —         |
| Phase 1: Admin API for deployment + binding CRUD                   | Not Started | 2   | —         |
| Phase 2: Multi-tenant isolation (per-tenant deployments + RLS)     | Not Started | 3   | —         |
| Phase 3: ToolHive operator + vMCP gateway (requires k8s migration) | Not Started | 5   | —         |

**Async MCP (when spec stabilizes):**

| Deliverable                                                           | Status      | Est | Work Item |
| --------------------------------------------------------------------- | ----------- | --- | --------- |
| MCP async task submission (server kicks off long-running work)        | Not Started | 2   | —         |
| Webhook callback for task completion notification                     | Not Started | 1   | —         |
| Align with `proj.governance-agents` CloudEvents signal infrastructure | Not Started | 1   | —         |

### Run (P2): Cross-Agent Delegation — Become Collaborative

**Goal:** Agents delegate work to each other across system boundaries.

**Depends on:** `proj.governance-agents` P0 (signal infra), `proj.thread-persistence` P1 (durable state), `proj.hil-graphs` P0 (approval gates)

| Deliverable                                                                                        | Status      | Est | Work Item |
| -------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| A2A task delegation — send task to external agent via A2A protocol                                 | Not Started | 2   | —         |
| A2A task reception — accept delegated tasks from external agents                                   | Not Started | 2   | —         |
| Cross-system agent delegation: LangGraph ↔ OpenClaw via MCP                                       | Not Started | 2   | —         |
| Graph-as-MCP-tool: expose LangGraph graphs as MCP tools (aligns with `proj.tool-use-evolution` P3) | Not Started | 2   | —         |
| Budget propagation: delegated tasks inherit execution grant limits                                 | Not Started | 1   | —         |
| Human-in-the-loop gate for cross-agent delegation (per `HUMAN_REVIEW_REQUIRED_MVP`)                | Not Started | 1   | —         |
| Agent reputation/trust signals from `proj.agent-registry` P2                                       | Not Started | 2   | —         |

## Constraints

- **MCP_SERVER_AUTH_REQUIRED** — All MCP endpoints require OAuth authentication. No anonymous tool access (learned from Feb 21 audit: 41% of MCP servers lack auth).
- **MCP_UNTRUSTED_BY_DEFAULT** — External MCP tools not auto-enabled on discovery (from `proj.tool-use-evolution`).
- **AGENT_IDENTITY_REQUIRED** — All outbound agent actions carry verifiable identity via OAuth token with `ActorId`.
- **HUMAN_REVIEW_REQUIRED_MVP** — Cross-agent delegation and autonomous spending require human approval initially.
- **REUSE_TOOL_PIPELINE** — MCP `tools/call` delegates to existing `toolRunner.exec()`. No parallel execution path.
- **NO_X402_YET** — x402 does not support streaming token billing (our primary cost). Evaluate when protocol matures for dynamic-amount use cases.

## Dependencies

- [x] `proj.tool-use-evolution` P0 — semantic types, tool policy, ToolSourcePort (mostly Done)
- [ ] `proj.tool-use-evolution` P2 — McpToolProvider, MCP discovery (subsumed by this project's P1)
- [ ] `proj.agent-registry` Identity Track P0 — AgentRegistrationDocument, AgentIdentityPort
- [ ] `proj.rbac-hardening` — agent actor types, OBO delegation
- [ ] `proj.tenant-connections` P1 — OAuth credential brokering for external MCP servers
- [ ] `proj.governance-agents` P0 — CloudEvents signal infra (for async MCP + A2A)
- [ ] `proj.thread-persistence` P1 — durable agent state for delegated tasks
- [ ] `proj.hil-graphs` P0 — human approval gates for cross-agent delegation

## External Dependencies

- NIST RFI on AI Agent Security (due March 9, 2026) — may inform identity model
- NIST Identity & Authorization paper (due April 2, 2026) — may inform OAuth approach
- MCP async spec (in working group) — P1 async design should track this
- A2A protocol spec (Linux Foundation) — P1 agent card format should align
- `@modelcontextprotocol/sdk` npm package — P0 implementation dependency

## As-Built Specs

- [tool-use.md](../../docs/spec/tool-use.md) — tool pipeline invariants (ToolSpec, ToolPolicy, toolRunner)
- [mcp-control-plane.md](../../docs/spec/mcp-control-plane.md) — MCP deployment registry, agent bindings, credential resolution, ToolHive path
- [agent-discovery.md](../../docs/spec/agent-discovery.md) — AgentCatalogPort, provider types
- [agent-registry.md](../../docs/spec/agent-registry.md) — AgentRegistrationDocument, identity port (draft)
- [Identity keys](https://cognidao.org/knowledge/identity-keys-no-overload) — orthogonal identity primitives

## Design Notes

**Why a separate project (not just accelerating `proj.tool-use-evolution` P2)?**

The MCP server is the nucleus, but the interoperability story spans identity (agent-registry), auth (rbac-hardening, tenant-connections), discovery (A2A agent cards), and delegation (governance-agents, hil-graphs). No single existing project owns this cross-cutting concern. This project coordinates the interop surface while each domain project retains ownership of its internals.

**P0 is intentionally narrow:** implement the MCP server + auth. This makes our agents addressable with minimal new code — the tool catalog, policy system, and toolRunner pipeline already exist. The MCP server is a thin adapter over existing infrastructure, which is exactly what hexagonal architecture enables.

**x402 is deliberately excluded.** The protocol is designed for pay-per-request (HTTP 402 → USDC → access). Our primary billing use case is streaming LLM inference with dynamic token costs, which x402 doesn't address. Our existing LiteLLM proxy audit → `charge_receipts` pipeline is the correct pattern for AI costs. We'll revisit x402 when it supports streaming/metered billing, or for non-streaming tool gating (data APIs, static resources) at P1+.

## PR / Links

- Handoff: [handoff](../handoffs/proj.agentic-interop.handoff.md)
