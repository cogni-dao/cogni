---
name: node-to-candidate-a
description: "Take a Cogni node from not-deployed to live-and-validated on candidate-a, as a node-contributor agent: get the developer role (env_manager also works), declare the workload, call POST /api/v1/deploy/workloads with env=candidate-a, prove the served build. Use when asked to 'get my node onto candidate-a', 'deploy node X to candidate-a', 'prove a node deploys e2e'. node-setup births the node first. validate-candidate posts the proof."
---

# Node to candidate-a

Start with your COGNI API key and a node id. End with the node answering on candidate-a at your exact commit.

Prerequisite: the node exists in the operator registry. If not, run [`node-setup`](../node-setup/SKILL.md) first.

## Steps

1. **Get the role.** Request `developer` on the node — candidate-a's least-privilege authority (`can_flight`); `env_manager` also works (bug.5574). The node owner approves. Nobody can self-approve. Use [agent-check-own-access](https://cognidao.org/knowledge/agent-check-own-access) to read your grants.

   ```bash
   curl -sS -X POST "https://cognidao.org/api/v1/nodes/$ID/access-requests" \
     -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"role":"developer"}'
   ```

2. **Declare.** Add `.cogni/workloads/<name>.yaml` to the node repo. Open a PR. CI publishes `sha-<head>`.
3. **Deploy the PR head.** Wait for `sha-<head>` in GHCR. Then:

   ```bash
   curl -fsS -X POST https://cognidao.org/api/v1/deploy/workloads \
     -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
     -d '{"nodeId":"<uuid>","env":"candidate-a","workload":"app","sourceSha":"<40-hex PR head>"}'
   ```

4. **Follow the release.** The POST returns a `releaseId`. Read `GET /api/v1/deploy/workloads/releases/<releaseId>?nodeId=<uuid>&env=candidate-a` every 30 s: `release.releaseState`, `release.parkedReason` and every attempt's steps with reasons. Done when `releaseState` is `active`. Never follow a deploy by polling `/version`: it shows the old release and never shows a failure or a stall. Failure signatures and the stall rule: [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) sections 4 and 5.
5. **Prove.** After `active`, read `https://<slug>-test.cognidao.org/version` once: `buildSha` is your commit. Then run [`validate-candidate`](../validate-candidate/SKILL.md) and post its scorecard. That scorecard is your definition of done.

The hub owns the details. Read [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) (declaration, watch, failures) and [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) (order and gates) before step 3.

## Invariants

- Request the role, then wait for the owner. Never write authorization tuples.
- A 200 from the verb records a release. It does not mean the node is live. The release reaching `active` is the deploy proof; one `/version.buildSha` read afterwards is the identity check.
- Never hand-apply anything to a cluster. The verb is the only writer of the node's app.
- Loki for the sequencer: `{env="production",service="sequencer"} |= "node_deploy_step" |= "<releaseId>"` (one production sequencer runs every lane).
