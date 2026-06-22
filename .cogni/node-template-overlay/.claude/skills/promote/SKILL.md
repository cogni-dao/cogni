---
name: promote
description: Deploy your spawned Cogni node to candidate-a, preview, or production — OR diagnose why a deploy silently failed. Use this skill whenever you say "/promote", "promote to preview", "promote to production", "ship to prod", "flight this sha", "deploy this PR", "heal preview", "prod is stuck on the old sha", or ask about preview/prod buildSha not advancing. Encodes the operator-API endpoints your node deploys through (POST /api/v1/vcs/flight, POST /api/v1/deploy/promote), the source-addressed image contract, the auto-preview trust ladder, and the /version.buildSha verify discipline. Do NOT trigger for ordinary code/test/build work; this is exclusively for the deploy ladder of THIS node.
---

# Promote — your node's deploy ladder

You operate a **spawned Cogni node** (a fork the operator hosts). This node is a
sovereign source repo: its own CI builds and pushes its image; the shared
**operator** validates a source revision and deploys the already-published image
digest. You never run a deploy workflow yourself — you call the operator API and
the operator's GitHub App performs every dispatch.

> If you are reading this inside the cogni-template monorepo (the operator
> control plane itself, with `nodes/operator/`, deploy branches, merge-queue
> leases, and `mq-*`/`pr-*` image tags), you are in the WRONG skill — that
> playbook is hub-internal and is intentionally NOT shipped to spawned nodes.
> This is the generic node-deploy skill.

## The ladder — three rungs, one promotion primitive

Every rung deploys the **same source-addressed image** your node CI already
published, by digest. Only the trigger and the authorization differ.

| Rung            | Trigger                                          | How you drive it                                                   | Authz (action → relation)                                                  |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **candidate-a** | you request a flight for a source SHA            | `POST /api/v1/vcs/flight` `{ nodeRef: { nodeId, sourceSha } }`     | `node.flight` → `can_flight` (the node `developer` role)                    |
| **preview**     | **automatic** on your node `main`-merge          | nothing — the operator promotes the merged build for you           | ungated (continues the trust earned at candidate-a)                         |
| **production**  | explicit request                                 | `POST /api/v1/deploy/promote` `{ nodeId, env: "production", sourceSha? }` | `node.promote_production` → `can_promote_production` (`production_promoter`) |

Endpoints are advertised at `/.well-known/agent.json` (`flight`, `promote`,
`nodeAccessRequest`, `nodeDevelopers`). Authenticate with your registered Bearer
key — **never a personal `gh` credential, never `gh workflow run`.**

## Source-addressed images (how a build becomes deployable)

Your node CI builds every flightable artifact once per source revision and
publishes it to **your own fork's GHCR** as:

```text
<image_repository>:sha-<40-char-sourceSha>
```

`sourceSha` is the deployment coordinate — never a PR number. The operator
resolves that tag to an immutable digest (`<image_repository>@sha256:<digest>`)
before writing any deploy state. No environment ever rebuilds your source; a
deploy is digest promotion, not a build.

`image_repository`, `source_repo`, and the catalog-pinned `source_sha` live on
your node's catalog row in the operator. On `promote` you may **omit**
`sourceSha` and the operator deploys the catalog-pinned digest.

## Candidate-a — flight a source SHA

```bash
# nodeId = your node's id in the operator registry. sourceSha = a 40-char commit
# on your node's main whose image CI already pushed as sha-<sourceSha>.
curl -sS -X POST "$BASE/api/v1/vcs/flight" \
  -H "Authorization: Bearer $COGNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"nodeRef":{"nodeId":"<node-uuid>","sourceSha":"<40-char-sha>"}}'
# 202 → operator dispatched candidate-flight (candidate-a only).
```

Before dispatch the operator verifies, in order: the node exists in the catalog;
`sourceSha` exists in your node repo; `.cogni/repo-spec.yaml` at that commit
matches the node identity; `image_repository:sha-<sourceSha>` exists in GHCR;
then it asserts the target substrate (read-only) and dispatches. A missing image
or missing substrate fails the flight loudly — the flight never provisions
substrate, it only asserts it.

## Preview — automatic, no action

When a PR merges to your node's `main`, the operator's GitHub App
**automatically** promotes that merged build to preview — source-addressed by
the merged head SHA, by digest. There is **no agent-facing preview endpoint** and
nothing to dispatch: preview rides the trust your node already earned at
candidate-a.

If preview looks stale, it is not healed by a hand-dispatch — it is healed by the
next `main`-merge (or by confirming your node's PR CI actually published the
`sha-<headSha>` image; the promote workflow hard-fails loudly when no image is
found). Verify with `/version.buildSha` (below), not by trusting a green run.

## Production — explicit, RBAC-gated

```bash
# sourceSha optional — omit it and the operator deploys the catalog-pinned digest.
curl -sS -X POST "$BASE/api/v1/deploy/promote" \
  -H "Authorization: Bearer $COGNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"nodeId":"<node-uuid>","env":"production"}'
# 200 {"dispatched":true,...} → operator GitHub App dispatched the promotion.
# 403 authz_denied → you lack can_promote_production (request the grant, below).
```

Production promotion is **app-digest only** (the API hard-sets `skip_infra=true`):
it reconciles your node's app image, not substrate. Per-node secrets
(`ExternalSecret`s) are still materialized by the operator's ungated substrate
lane, so a no-infra promote does not skip secret reconciliation.

### Need the production grant?

```bash
# 1. You self-request the role:
curl -sS -X POST "$BASE/api/v1/nodes/<node-uuid>/access-requests" \
  -H "Authorization: Bearer $COGNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"role":"production_promoter"}'
# 2. The node OWNER approves once:
#    POST /api/v1/nodes/<node-uuid>/developers {agentUserId, decision:"approve", role}
```

Result codes everywhere on this ladder:
`403 authz_denied` = no grant; `503 authz_unavailable` = that env's OpenFGA store
is unbootstrapped (≠ denial); `502 dispatch_failed` = RBAC passed but that env's
operator App isn't installed.

## Verify discipline — `/version.buildSha` is the only truth

A green workflow conclusion can lie about what is serving. **Trust
`/version.buildSha` from outside the cluster**, never the run conclusion and
never `/readyz` (the old pod can still answer `/readyz` mid rolling-cutover and
return the prior buildSha).

```bash
# After any flight/promote, poll your node's host until buildSha == sourceSha.
curl -sk "https://<your-node-host>/version" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("buildSha","")[:12])'
# Compare against the first 12 chars of the sourceSha you flighted/promoted.
```

Your node's host comes from its catalog/DNS row (e.g. candidate-a, preview, and
production each have their own hostname). Confirm the env's host before polling;
do not assume.

## Discipline checklist

- **`/version.buildSha` is the only deploy verification that matters.** CI
  conclusions lie; `/readyz` lies during cutover.
- **Drive the ladder over HTTP with your Bearer key.** `vcs/flight`,
  `deploy/promote`, `access-requests`, `developers`. Never `gh workflow run`,
  never a personal credential.
- **Images are source-addressed by `sourceSha`.** A PR number is review
  metadata, not a deploy coordinate; the operator rejects PR-shaped tags at
  flight.
- **Preview is automatic.** Don't hand-dispatch it; re-merge or confirm the
  image, then verify `/version`.
- **Production is irreversible + gated.** Request `production_promoter`, verify
  `/version` advanced, and don't assume a 200 means it is serving yet.
