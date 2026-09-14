---
id: bug.5016.handoff
type: handoff
work_item_id: bug.5016
status: active
created: 2026-09-14
updated: 2026-09-14
branch: main
last_commit: e6f585b125
---

# Handoff: Operator secrets plane — silent reverts, silent field-strip, refresh latency

## Mission

Pickup: you own the **operator self-serve secrets write plane**. It is now the single sanctioned no-kube path for human-minted credentials (kube is legacy and unavailable on dev machines), and the Akash wallet cutover just became its first real production-grade consumer. Three defects surfaced under that load — one of them misfiled a live wallet credential into a bucket the public app can read. None are theoretical; all were observed this session.

## Goal

- A human/vendor value written through `POST /api/v1/nodes/<id>/secrets` **lands where the caller asked, stays there across reconciles, and reaches the pod promptly** — or fails loudly.
- **E2E validation:** write a `source: human` key to a platform-service bucket, run a full candidate-a flight (which runs `node-substrate` -> `secret-materialize`), and prove the value still resolves afterward; then prove a rejected/unknown field returns a typed 4xx instead of being silently dropped.
- Deploy behavior is in scope: prove on candidate-a via operator flight, `https://test.cognidao.org/version` `.buildSha` matching the flighted SHA exactly.

## Start By Reading

- `bug.5016` work item (the original `_shared`/`source: human` revert analysis).
- `nodes/operator/app/src/app/api/v1/nodes/[id]/secrets/route.ts` — the route; `WriteSecretInput` is the schema at issue.
- `nodes/operator/app/src/adapters/server/.../OpenBaoSecretsAdapter` + `scripts/ci/secret-materialize.sh` (the reconcile-time writer).
- `docs/spec/secrets-management.md` — the three entry points and Invariants 1-18.
- `.claude/skills/cicd-secrets-expert/SKILL.md` — authority model, tier routing, killer rule.
- `infra/k8s/overlays/candidate-a/operator/akash-tx-actuator*-external-secret.yaml` — the new platform-service plane.

## Current State

- **#2214 is merged** (`e6f585b125`): the route gained an optional `service` param so it can address a **platform-service** bucket (`cogni/<env>/akash-tx-actuator/*`), constrained to the `PLATFORM_SERVICES` allowlist + owner-node (`operator`) delegation. This was the unblock for the Akash wallet; it also **widened `secrets_manager@node:operator`** to reach platform buckets.
- **#2217 is OPEN and unmerged** — drops both actuator ExternalSecrets from `refreshInterval: 1h` to `1m`. Correct but was deprioritized as tangential; it is yours now.
- A real credential (`AKASH_ACTUATOR_CONSOLE_API_KEY`) is live at `cogni/candidate-a/akash-tx-actuator/` v3 and **should be rotated** — it briefly landed in `cogni/candidate-a/operator` (see defect 2), which the public Next.js app reads wholesale via `dataFrom: extract` + `envFrom`.
- No kube on dev machines (local `kind` context only) — every fix must be provable through operator APIs, Loki, and Argo events.

## Design / Implementation Target

1. **Defect 1 — silent revert (the original bug.5016).** A `source: human` value written through the route can be clobbered by a later reconcile while the write returned `200`. Predicted by review, then observed during the Akash cutover. Required outcome: a human value either survives reconcile, or the write refuses up front with a typed error naming the conflict. Silent loss of a credential is the failure mode to eliminate.
2. **Defect 2 — silent field-strip (new, and it cost real exposure).** `WriteSecretInput` is a permissive `z.object()`, so an **unrecognized field is dropped rather than rejected**. When candidate-a was running a build that predated `service`, a write carrying `service: "akash-tx-actuator"` was accepted with `200` and silently filed to the node-stamped path `cogni/candidate-a/operator/...` — putting a wallet credential in the public app's bucket. Required outcome: **strict schema**; an unknown or unsupported field is a 4xx, never a silent fallback. A credential write must never succeed at the wrong path.
3. **Defect 3 — refresh latency on a credential plane.** `refreshInterval: 1h` means a rotation takes up to an hour to reach the pod; for a wallet writer that fails closed, a stale credential is indistinguishable from a revoked one. #2217 lowers it to `1m`. Land it, and consider whether `1h` is wrong as a default anywhere a `source: human` credential lives.
4. **Deferred, and genuinely yours:** the `platform_service` OpenFGA type + its own `secrets_manager` relation. #2214 used owner-node delegation instead, because a new relation only reaches an env through `bootstrap-openfga.sh` inside `deploy-infra`, and a check against a relation the env's model lacks fails closed at `503 authz_unavailable` (the task.5049 drift class). That is the correct end state; it was a blocker, not a fix, at the time.
5. **Boundary that must hold:** the wallet credential never returns to `cogni/<env>/operator`. Isolation is structural — no ExternalSecret, `envFrom`, or volume in the operator Deployment may name the actuator bucket.
6. **Do not regress:** the no-`service` path must stay byte-identical (existing node writes), `_system`/`_shared` denial, `409 wrong_operator_env` pre-authz, substrate-reserved-key refusal, and value-never-logged/argv/returned.

## Next Actions / Risks

- [ ] Make `WriteSecretInput` strict (defect 2) — highest value per line; it is the one that already caused exposure.
- [ ] Fix or fail-closed the reconcile revert (defect 1).
- [ ] Merge #2217; audit `refreshInterval` across credential-bearing ExternalSecrets.
- [ ] Rotate `AKASH_ACTUATOR_CONSOLE_API_KEY` and coordinate the re-write with the Akash dev-manager (`story.5016`) — the actuator fails closed, so a rotation without a projection is an outage for that component.
- [ ] Land the `platform_service` OpenFGA relation and narrow the `secrets_manager@node:operator` widening.

**Gotchas:**
- **OpenFGA stores are per-environment.** A grant approved on the production operator does NOT reach candidate-a; the symptom is `403` (tuple missing) vs `503` (relation missing in that env's model) — the distinction tells you which fix applies.
- The route's authz denies **before** service/key-specific checks, so `unknown_platform_service` and `key_reserved` are currently indistinguishable from generic `authz_denied` externally. Diagnosability gap, not a security one.
- `secret-materialize.sh` gained a platform-service pass in #2211 that runs on the **owner leg only** (`PLATFORM_SERVICE_OWNER_NODE`) because `node-substrate` is a parallel matrix — preserve that, or concurrent legs mint into one cold path.
