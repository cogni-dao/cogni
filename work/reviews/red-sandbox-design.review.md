# Design Review: red-node-sandbox-design (Red story.0002), reviewed as the operator + node-template standard for agent shell access

Reviewed 2026-10-15 against the [Red inbox](https://red.cognidao.org/knowledge/inbox/contrib-derek-conductor-dereks-macbook-p-2c9d2b3e), the story.0002 outcome, [`docs/spec/sandboxed-agents.md`](https://github.com/cogni-dao/cogni/blob/996d1a7793/docs/spec/sandboxed-agents.md), [`sandbox-runner.port.ts`](https://github.com/cogni-dao/cogni/blob/996d1a7793/nodes/operator/app/src/ports/sandbox-runner.port.ts), and the [tenancy standard](https://cognidao.org/knowledge/shared-substrate-tenancy-standard).

## Summary

Red proposes a `red-ops` service that gives `red-solver` a native agent-computer interface (ACI) over MCP: persistent shell, filesystem, and interactive tools. A spike first decides the isolation substrate: (A) nsjail inside one privileged Akash cell, or (B) a managed microVM per session.

## Through-line

Red's success sentence is "red-solver solves ≥1 non-web challenge in an egress-scoped ACI." The CEO's success sentence is "any node's agents get shell access by a standard the operator supports." The design serves the first and only gestures at the second. Its biggest cost, a new privileged Akash tier, buys a Red-only optimization that the standard cannot use, because the design's own `NS_ISOLATION_SELF_OWNED_ONLY` already forbids shared-kernel isolation for untrusted input.

## Scorecard

| Dimension              | Score   | Rationale                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simplicity             | CONCERN | Two substrates, a gating spike, hand-built session routing, per-session nftables, and a queryable substrate-class property. Choosing microVM-only deletes the spike, the privilege tier, the class gate, and the nftables work.                                                                                                                       |
| OSS-First              | CONCERN | E2B (Apache-2.0 [SDK](https://github.com/e2b-dev/E2B) and self-hostable [runtime](https://github.com/e2b-dev/runtime)) already ships the exact ACI: persistent sandboxes keyed by id, exec, background processes, fs read/write, and per-sandbox network rules. A bespoke `red-ops` session service plus token→environment routing reimplements it.   |
| Architecture Alignment | CONCERN | It ignores the existing canon `sandboxed-agents.md` (SANDBOX_IS_GRAPH_PROVIDER, SYSTEM_GRANT_REQUIRED, SECRETS_HOST_ONLY). MCP-tools-in-sandbox (the loop stays in LangGraph) is the better model, but it must explicitly extend or supersede that spec, or we get two sandbox canons. There is no ExecutionGrant-style gate on who may open a shell. |
| Boundary Placement     | FAIL    | "New adapter behind `SandboxRunnerPort`" is wrong twice. The port is app-local (`nodes/operator/app/src/ports/`, copied per node), and it is a one-shot `network=none` docker run contract. A persistent session is a different capability, so it needs a new `SandboxSessionPort` in a shared package that node-template inherits.                   |
| Knowledge Home         | FAIL    | There is one `decision` entry and no human-facing `html` entry. The story.0002 outcome carries a design body ("INFRA REALITY", "CORRECTED PATH", a checklist to edit `docs/design/red-agent-mvp.md`). That violates WORK_ITEM_CONTRACT and keeps a markdown design alive.                                                                             |
| Scope Discipline       | CONCERN | A Red story is asking the operator for a new fleet privilege tier and is quietly deciding the fleet sandbox standard. Split it: the operator/node-template story owns the sandbox substrate; Red consumes it.                                                                                                                                         |
| Risk Surface           | CONCERN | Substrate A grants CAP_NET_ADMIN, nested userns, and cgroup delegation on third-party Akash hosts, which is an escape surface on hardware we don't control. Akash providers can also read sandbox contents. Cost is unstated: E2B cloud is paid, and self-hosting needs KVM-capable bare metal (new spend).                                           |

## Blocking Issues

1. **Boundary:** define `SandboxSessionPort` (`create / exec / execBackground / fsRead / fsWrite / kill`, session = sandbox id) in a shared package. Put the E2B-SDK adapter in that package and the env/credential wiring in the app. Leave the dockerode `SandboxRunnerPort` alone as the dev/CI one-shot path.
2. **Knowledge Home:** remove the design body from story.0002, leaving the contract and pointers. Add an `html` visual entry. Make `red-agent-mvp.md` a pointer or delete it.

## Required Changes (standard)

1. **MicroVM-class only for the standard.** Drop substrate A and BLOCKER-0 from the standard path. Red may run the cents-cheap spike later as a self-owned-target optimization, but nothing in the standard depends on it.
2. **Instantiate the tenancy standard.** Sandbox becomes a substrate profile with tiers `external` (the node sets an E2B-compatible URL and API key, shipping day 1 as config only, with no operator privilege grant), then `shared` / `dedicated` (operator self-hosts the E2B runtime once metered demand justifies KVM capacity). This is verb 9 (sovereign) by construction.
3. **Gate + audit.** Carry SYSTEM_GRANT_REQUIRED forward: shell sessions require an explicit grant per graph. Keep SECRETS_HOST_ONLY (no LLM or provider credentials in the sandbox; the design already drops the socket proxy, which is good). Keep the per-session egress allowlist through the provider's network policy.
4. **Reconcile canon:** a spec PR updates `sandboxed-agents.md` to the session-port and MCP model, or marks the docker-runner section as dev-only.

## Keep (good)

The loop, telemetry, and scope-guard stay in LangGraph (ONE_RUN_EXECUTION_PATH). The MCP seam mirrors the browser graph. Durability fails closed on restart. Backpressure is honest. The v0 acceptance is a non-web solve plus ≥2 isolated concurrent sessions.

## Verdict: REQUEST CHANGES

Red can start P1 today on an E2B cloud key behind the new port, with no operator dependency. The operator story owns the `SandboxSessionPort` package and the sandbox substrate profile.
