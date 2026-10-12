---
id: spec-index
type: spec
title: Specification Index
status: draft
trust: draft
summary: Index of all system specifications in this repository.
read_when: You need to find a specification document.
owner: derekg1729
created: 2026-02-05
verified: 2026-02-05
tags: [index]
---

# Specification Index

**A Spec is** a design contract for pending or existing code — the invariants that reviewers and agents enforce.

This is a master index of all specs, updated as specs are migrated.

## Specifications

| ID                               | Title                                        | State    | Domain     | Location                                                           |
| -------------------------------- | -------------------------------------------- | -------- | ---------- | ------------------------------------------------------------------ |
| spec.accounts-api-endpoints      | Accounts & LiteLLM Virtual Keys              | draft    | billing    | [accounts-api-endpoints.md](./accounts-api-endpoints.md)           |
| spec.accounts-design             | Accounts & Credits System Design             | draft    | billing    | [accounts-design.md](./accounts-design.md)                         |
| activity-metrics-spec            | Activity Metrics Design                      | draft    | billing    | [activity-metrics.md](./activity-metrics.md)                       |
| agent-discovery-spec             | Agent Discovery Architecture                 | draft    | ai-graphs  | [agent-discovery.md](./agent-discovery.md)                         |
| agent-registry                   | Agent Registry                               | draft    | ai-graphs  | [agent-registry.md](./agent-registry.md)                           |
| ai-evals-spec                    | AI Architecture and Evals                    | draft    | ai-graphs  | [ai-evals.md](./ai-evals.md)                                       |
| ai-governance-data-spec          | AI Governance Data Design                    | draft    | data       | [ai-governance-data.md](./ai-governance-data.md)                   |
| ai-setup-spec                    | AI Setup Specification                       | active   | ai-graphs  | [ai-setup.md](./ai-setup.md)                                       |
| authentication-spec              | Authentication                               | draft    | auth       | [authentication.md](./authentication.md)                           |
| billing-evolution-spec           | Billing Evolution                            | draft    | billing    | [billing-evolution.md](./billing-evolution.md)                     |
| build-architecture-spec          | Build Architecture                           | draft    | deployment | [build-architecture.md](./build-architecture.md)                   |
| chain-action-flow-ui-spec        | Chain Action Flow UI                         | draft    | web3       | [chain-action-flow-ui.md](./chain-action-flow-ui.md)               |
| chain-config-spec                | Chain Configuration                          | draft    | web3       | [chain-config.md](./chain-config.md)                               |
| check-full-spec                  | check:full CI-Parity Gate                    | draft    | deployment | [check-full.md](./check-full.md)                                   |
| claude-sdk-adapter               | Claude Agent SDK Adapter                     | draft    | ai-graphs  | [claude-sdk-adapter.md](./claude-sdk-adapter.md)                   |
| cred-licensing-policy            | Cred Licensing Policy                        | draft    | web3       | [cred-licensing-policy.md](./cred-licensing-policy.md)             |
| dao-enforcement-spec             | DAO Enforcement — Financial Rails            | draft    | web3       | [dao-enforcement.md](./dao-enforcement.md)                         |
| database-rls-spec                | Database Row-Level Security                  | draft    | infra      | [database-rls.md](./database-rls.md)                               |
| database-url-alignment-spec      | Database URL Alignment                       | draft    | infra      | [database-url-alignment.md](./database-url-alignment.md)           |
| environments-spec                | Environment & Deployment Modes               | draft    | deployment | [environments.md](./environments.md)                               |
| error-handling-spec              | Error Handling Architecture                  | draft    | meta       | [error-handling.md](./error-handling.md)                           |
| external-executor-billing-spec   | External Executor Billing                    | draft    | billing    | [external-executor-billing.md](./external-executor-billing.md)     |
| graph-execution-spec             | Graph Execution Design                       | draft    | ai-graphs  | [graph-execution.md](./graph-execution.md)                         |
| git-sync-repo-mount-spec         | Git-Sync Repo Mount                          | draft    | deployment | [git-sync-repo-mount.md](./git-sync-repo-mount.md)                 |
| gov-data-collectors-spec         | Governance Data Collectors                   | draft    | data       | [gov-data-collectors.md](./gov-data-collectors.md)                 |
| spec.health-probes               | Health Probe Separation                      | draft    | deployment | [health-probes.md](./health-probes.md)                             |
| human-in-the-loop-spec           | Human-in-the-Loop (HIL) Design               | draft    | ai-graphs  | [human-in-the-loop.md](./human-in-the-loop.md)                     |
| langgraph-patterns-spec          | LangGraph Patterns                           | draft    | ai-graphs  | [langgraph-patterns.md](./langgraph-patterns.md)                   |
| langgraph-server-spec            | LangGraph Server Integration                 | draft    | ai-graphs  | [langgraph-server.md](./langgraph-server.md)                       |
| model-selection-spec             | Model Selection                              | draft    | ai-graphs  | [model-selection.md](./model-selection.md)                         |
| n8n-adapter-spec                 | n8n Workflow Execution Adapter               | draft    | ai-graphs  | [n8n-adapter.md](./n8n-adapter.md)                                 |
| node-formation-spec              | Node Formation Design                        | draft    | web3       | [node-formation.md](./node-formation.md)                           |
| spec.node-ci-cd-contract         | Node CI/CD Contract                          | draft    | deployment | [node-ci-cd-contract.md](./node-ci-cd-contract.md)                 |
| spec.repo-sync-contract          | Multi-Repo Sync Contract                     | draft    | deployment | [repo-sync-contract.md](./repo-sync-contract.md)                   |
| node-operator-contract-spec      | Node vs Operator Contract                    | draft    | meta       | [node-operator-contract.md](./node-operator-contract.md)           |
| private-node-repo-contract-spec  | Private Node Repos & Sovereign node-template | draft    | meta       | [private-node-repo-contract.md](./private-node-repo-contract.md)   |
| spec.onchain-readers             | On-Chain Treasury & Ownership                | draft    | web3       | [onchain-readers.md](./onchain-readers.md)                         |
| openclaw-sandbox-controls-spec   | OpenClaw Sandbox Controls Design             | draft    | ai-graphs  | [openclaw-sandbox-controls.md](./openclaw-sandbox-controls.md)     |
| openclaw-sandbox-spec            | OpenClaw Sandbox Integration                 | draft    | ai-graphs  | [openclaw-sandbox-spec.md](./openclaw-sandbox-spec.md)             |
| sandboxed-agents-spec            | Sandboxed Agent System                       | draft    | ai-graphs  | [sandboxed-agents.md](./sandboxed-agents.md)                       |
| sandbox-scaling-spec             | Sandbox Proxy Scaling Design                 | draft    | ai-graphs  | [sandbox-scaling.md](./sandbox-scaling.md)                         |
| packages-architecture-spec       | Packages Architecture                        | draft    | infra      | [packages-architecture.md](./packages-architecture.md)             |
| payments-design-spec             | Payments: USDC with Backend Verify           | draft    | billing    | [payments-design.md](./payments-design.md)                         |
| prompt-registry-spec             | Prompt Registry                              | draft    | ai-graphs  | [prompt-registry.md](./prompt-registry.md)                         |
| public-analytics-spec            | Public Analytics Page                        | draft    | data       | [public-analytics.md](./public-analytics.md)                       |
| runtime-policy-spec              | Route Runtime Policy                         | draft    | deployment | [runtime-policy.md](./runtime-policy.md)                           |
| spec.tenant-connections          | Tenant Connections Design                    | draft    | auth       | [tenant-connections.md](./tenant-connections.md)                   |
| temporal-patterns-spec           | Temporal Patterns                            | draft    | ai-graphs  | [temporal-patterns.md](./temporal-patterns.md)                     |
| security-auth-spec               | Security & Authentication                    | draft    | auth       | [security-auth.md](./security-auth.md)                             |
| services-architecture-spec       | Services Architecture                        | draft    | deployment | [services-architecture.md](./services-architecture.md)             |
| sourcecred-config-rationale-spec | SourceCred Configuration Rationale           | draft    | community  | [sourcecred-config-rationale.md](./sourcecred-config-rationale.md) |
| spec.tool-use                    | Tool Use Specification                       | draft    | ai-graphs  | [tool-use.md](./tool-use.md)                                       |
| spec.unified-graph-launch        | Unified Graph Launch Design                  | draft    | ai-graphs  | [unified-graph-launch.md](./unified-graph-launch.md)               |
| ui-implementation-spec           | UI Implementation                            | draft    | meta       | [ui-implementation.md](./ui-implementation.md)                     |
| thread-persistence               | Thread Persistence & Transcript Authority    | draft    | data       | [thread-persistence.md](./thread-persistence.md)                   |
| scheduler-spec                   | Scheduler Specification                      | active   | ai-graphs  | [scheduler.md](./scheduler.md)                                     |
| cogni-brain-spec                 | Cogni Brain Specification                    | proposed | ai-graphs  | [cogni-brain.md](./cogni-brain.md)                                 |
| rbac-spec                        | RBAC Specification                           | active   | auth       | [rbac.md](./rbac.md)                                               |
| observability-spec               | Observability Specification                  | active   | data       | [observability.md](./observability.md)                             |
| spec.observability-requirements  | Required Observability Design                | draft    | data       | [observability-requirements.md](./observability-requirements.md)   |
| ci-cd-spec                       | CI/CD Specification                          | active   | deployment | [ci-cd.md](./ci-cd.md)                                             |
| databases-spec                   | Databases Specification                      | active   | infra      | [databases.md](./databases.md)                                     |
| docs-work-system-spec            | Docs + Work System Spec                      | draft    | infra      | [docs-work-system.md](./docs-work-system.md)                       |
| architecture-spec                | Cogni-Template Architecture                  | active   | meta       | [architecture.md](./architecture.md)                               |
| style-spec                       | Style Specification                          | active   | meta       | [style.md](./style.md)                                             |
| system-test-architecture-spec    | System Test Architecture                     | draft    | deployment | [system-test-architecture.md](./system-test-architecture.md)       |
| spec.system-tenant               | System Tenant & Governance                   | draft    | auth       | [system-tenant.md](./system-tenant.md)                             |
| development-lifecycle            | Development Lifecycle                        | proposed | workflows  | [development-lifecycle.md](./development-lifecycle.md)             |

### Domains

| Domain       | Description                                 |
| ------------ | ------------------------------------------- |
| `ai-graphs`  | AI execution, LangGraph, prompts, tools     |
| `auth`       | Authentication, authorization, RBAC         |
| `billing`    | Credits, payments, metering                 |
| `community`  | Attribution, contributions                  |
| `data`       | Observability, logging, metrics, tracing    |
| `deployment` | CI/CD, environments, containers             |
| `infra`      | Databases, caching, docs system             |
| `meta`       | Architecture, style, cross-cutting concerns |
| `web3`       | Wallets, chains, DAO governance             |
| `workflows`  | Development lifecycle, PR conventions       |

## Pending Migration

Legacy specs in `/docs/*.md` to be migrated to `/docs/spec/`:

- DATABASE_RLS_SPEC.md

## Adding a Spec

1. Copy `docs/_templates/spec.md`
2. Place in `docs/spec/`
3. Add entry to table above
