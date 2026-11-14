# node-streams · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Generic streaming backbone for continuous node-level data streams. Provides port interface, Redis Streams adapter, SSE encoder, and common event types. Nodes extend with domain-specific events.

## Pointers

- [Data Streams Spec](https://node-template.cognidao.org/knowledge/node-streams-transport): Design, invariants, polling budget
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules): Package boundaries

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": ["app", "features", "adapters", "core", "ports"]
}
```

## Public Surface

- **Types:** `NodeEventBase`, `NodeEvent`, `HealthEvent`, `CiStatusEvent`, `DeployEvent`, `NodeStreamEntry<T>`, `NodeStreamPort<T>`
- **Classes:** `RedisNodeStreamAdapter<T>` — Redis Streams implementation of `NodeStreamPort<T>`
- **Functions:** `encodeSSE<T>()` — converts `AsyncIterable<NodeStreamEntry<T>>` to SSE `ReadableStream`
- **Constants:** `NODE_STREAM_MAXLEN` (2000), `NODE_STREAM_BLOCK_MS` (5000)

## Ports

- **Defines ports:** `NodeStreamPort<T>` — publish/subscribe/streamLength for MAXLEN-trimmed continuous streams
- **Implements ports:** none (adapter wired in node bootstrap)

## Responsibilities

- This directory **does**: Define the port interface, provide the Redis adapter, encode events as SSE
- This directory **does not**: Define domain-specific events, manage Redis connections, implement routes

## Notes

- `ioredis` is a runtime dependency — constructor-injected, not imported at module level
- Domain events (e.g., `MarketSnapshotEvent`) belong in the node that produces them (DOMAIN_EVENTS_IN_NODE)
