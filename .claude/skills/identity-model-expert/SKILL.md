---
name: identity-model-expert
description: "Identity and authority navigation for Cogni nodes. Use when deciding who a caller is, what a human, AI agent or company may do on a node, or who gets paid. Covers identity, authentication, authorization, authz, login, API keys, principals, agents vs humans, credentials, grants, roles, role rows, RLS, agent tool authority, wallets, beneficiaries, DAO admins, user bindings, OpenFGA vs node SQL grants (@cogni-dao/agent-grants), and any 'who may do what' question. Triggers: 'identity', 'principal', 'agent principal', 'agent credential', 'authorization', 'authz', 'login', 'API key', 'grant', 'role row', 'RLS', 'tool authority', 'beneficiary', 'wallet', 'billing_account_id', 'user_id vs actor_id', 'user_bindings', 'node admin', 'DAO root', 'who may do X', 'agent acts as human', 'delegated access', 'add a permission'. Loads the hub identity-expert and routes to its atoms. Does not restate them."
---

# identity-model-expert

The canon lives in the hub. This file only triggers it and routes to it. Do not copy canon text here; it rots.

## Load first

Read the full body before you act. Use the current node's origin (operator: `https://cognidao.org`) and the `COGNI_NODE_API_KEY` saved in `.env.cogni`:

```bash
curl -fsS -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  "https://cognidao.org/api/v1/knowledge/identity-expert" | jq -er .content
```

If the fetch fails, retry once. If it still fails, report the failure. Do not decide identity or permission questions from memory.

## Route by need

Read the atom in full with the same call: `GET /api/v1/knowledge/<id>`. Pick only the atoms your task needs.

| Use when                                                                                            | Atom                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| You need the whole standard: claims, credentials, permissions, payout                               | `human-ai-identity-standard`                                                                            |
| You add a permission, a scope, or a tool that needs one, or a human lets an AI act on their account | `node-capability-grants-standard`                                                                       |
| You wire an agent launcher or its tools, or ask why a graph gets no scoped tools                    | `node-capability-grants-standard` §Runtime identity does not depend on hosting (pending inbox 8c401ea7) |
| You add a column, table, key or API field that says who or what                                     | `identity-keys-no-overload`                                                                             |
| You onboard an AI into a repo or external system and choose its account and credentials             | `agent-identity-not-human`                                                                              |
| You decide who earns, who is paid, and which wallet claims                                          | `node-economic-identity`                                                                                |
| You add a login method or link a wallet or GitHub account to a user                                 | `user-identity-bindings`                                                                                |
| You read node admin inheritance, or separate Cogni authority from GitHub App and repo roles         | `node-admin-boundary`                                                                                   |
| You need to know how the operator authenticates and authorizes callers today                        | `operator-identity-model`                                                                               |
| A human needs a diagram of how identities relate                                                    | `node-identity-relations-visual`                                                                        |

The `identity-expert` route table lists more atoms, for example other nodes' identity models and spend authority. Follow it when this table has no match.

## Which authority decides

Read `node-capability-grants-standard` for the target: node account and agent-tool authority uses node-local SQL through `@cogni-dao/agent-grants`, and no node runs its own OpenFGA store.

Today differs from that target. The operator still uses OpenFGA for its own goals, priority and knowledge merges, and for its deploy plane (developer, promoter, secrets, env membership). `@cogni-dao/agent-grants` is not yet adopted on operator main. Check the code before you claim which one applies.

For the operator's OpenFGA mechanics, read the repo skill [`rbac-expert`](../rbac-expert/SKILL.md). Its rule "OpenFGA is the sole authority" applies to the operator's plane only.

## Change the canon, not this file

If the canon is wrong or missing, refine the hub entry in place through `knowledge-contribution-flow`. Then keep this file a pointer.
