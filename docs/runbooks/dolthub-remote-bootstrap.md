# DoltHub Mirror — One-Time Bootstrap

> Filed by task.5069 (v0 knowledge mirror). Successor's responsibility: do **this** once per cluster lifecycle, never again.

## Why this exists

The webapp pushes the canonical knowledge branch to DoltHub after every successful contribution merge. DoltHub's push protocol does **not** accept Personal Access Tokens — it requires a **Dolt cred** (cryptographic keypair). This file documents the one-time setup that gives the doltgres container a valid cred.

The end state: the webapp owns 100% of runtime push/pull. This bootstrap is the only manual step, and the agent picking up task.5069 is the one who runs it. Derek doesn't do it.

## What's automated vs. manual (truth, after the 2026-05-28 spike)

| Step                                     | Status             | How                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create the DoltHub repo                  | 🟢 fully automated | `POST /api/v1alpha1/database` with PAT — see Step 1                                                                                                                                                                                                                                                               |
| Generate Dolt keypair                    | 🟢 automated       | `dolt creds new` on any host with the CLI                                                                                                                                                                                                                                                                         |
| Set GitHub Environment Secrets           | 🟢 automated       | `pnpm setup:secrets --only DOLTHUB_REMOTE_URL,DOLT_CREDS_JWK,DOLT_CREDS_KEYID`                                                                                                                                                                                                                                    |
| **Register pubkey with DoltHub account** | **🔴 UI-only**     | Paste at https://www.dolthub.com/settings/credentials — DoltHub does not expose a REST endpoint for credential registration (verified across `POST /credentials`, `/user/credentials`, `/keys`, `/user/keys`, `/creds`, `/user/creds`, GraphQL, all 404 or 400-only-GET). This is the only remaining manual step. |

`dolt creds check` against an unregistered key confirms the gating mechanism: `rpc error: code = Unauthenticated desc = jwt_token validation failed: key not found`. The keypair exists locally and in the doltgres container; DoltHub's auth subsystem doesn't recognize it until the pubkey is registered.

## Spike findings underlying this design

- DoltHub docs (`/docs/products/dolthub/api/authentication`): API tokens authenticate the **REST/SQL HTTP API only** ("over Basic Authentication").
- DoltHub docs (`/docs/products/dolthub/api/database`): `POST /api/v1alpha1/database` accepts PAT and creates a repo — earlier handoff was wrong about "no REST endpoint for repo creation." The endpoint exists, takes `{ownerName, repoName, description, visibility}`, returns `{status:"Success",...}`.
- Dolt docs (`/docs/cli-reference/cli`): `dolt creds` "Create a new public/private keypair for authenticating with doltremoteapi." Pubkey is registered in DoltHub settings; privkey signs the push handshake.
- DoltHub's GRPC remote (`doltremoteapi.dolthub.com`) returns the same `PermissionDenied` for "no such repo" AND "wrong auth" — so spike attempts against nonexistent repos cannot distinguish. Full e2e validation requires both the repo and the cred to exist.

## Prerequisites for the agent running this

- `dolt` CLI installed on a bootstrap host (your laptop, a one-shot container, anywhere you can run a Go binary). Doltgres does **not** ship the `dolt` CLI, so the keypair must be generated externally.
- A DoltHub account that owns the `cogni-dao` organization (or has admin rights).
- `gh` CLI authenticated and able to write GitHub Environment Secrets in `Cogni-DAO/cogni`.

## Step 1 — Create the DoltHub repo (per node hub) — AUTOMATABLE via REST

DoltHub exposes `POST /api/v1alpha1/database` with PAT auth (confirmed 2026-05-28). Repo creation does NOT require the UI.

For the operator node specifically:

```bash
# DOLTHUB_API_TOKEN must be exported (it lives in .env.operator locally and
# in GitHub Environment Secrets for the deployed envs).
curl -sS -X POST \
  -H "authorization: token $DOLTHUB_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "ownerName": "cogni-dao",
    "repoName": "knowledge-operator",
    "description": "Cogni operator knowledge mirror",
    "visibility": "public"
  }' \
  "https://www.dolthub.com/api/v1alpha1/database"

# Expected: {"status":"Success","repository_owner":"cogni-dao","repository_name":"knowledge-operator",...}
# Idempotency: re-running returns "Error: database already exists" — safe to ignore.
```

Repeat with different `repoName`s for each node hub (`knowledge-poly`, `knowledge-resy`, ...). v0 only mirrors operator.

Verification:

```bash
curl -sS -H "authorization: token $DOLTHUB_API_TOKEN" \
  "https://www.dolthub.com/api/v1alpha1/cogni-dao/knowledge-operator/main?q=SELECT+1"
# Expect: {"query_execution_status":"Success",...} (or a structured Dolt schema response)
```

## Step 2 — Generate the Dolt cred

On the bootstrap host:

```bash
dolt creds new
```

Output looks like:

```
Credentials created successfully.
pub key: <pubkey-hex>
0 of 1 keys associated with this account
Run dolt creds use <keyid> to associate this credential with your account.
```

The keyid is also the filename:

```bash
ls ~/.dolt/creds/
# <keyid>.jwk
```

Capture **both**:

- `keyid` — alphanumeric, ~52 chars
- contents of `~/.dolt/creds/<keyid>.jwk` — single-line JSON, ~few hundred bytes

## Step 3 — Register the pubkey with DoltHub

1. https://www.dolthub.com/settings/credentials
2. Paste the pubkey from `dolt creds new` output.
3. Confirm it appears in the list.

This pubkey is the **service identity** for the operator-app's push job. It is not Derek's personal cred; it belongs to the operator service for as long as v0 lives. Rotation = repeat Steps 2–3 with a new keypair and update the secrets.

## Step 4 — Set the GitHub Environment Secrets (prod-only writer)

**`DOLTHUB_REMOTE_URL` is set ONLY in `production`.** The DoltHub mirror is a public canonical history — test and preview must never push to it (their commit graphs would diverge from prod, and contributor attribution would be wrong). `DOLT_CREDS_JWK` and `DOLT_CREDS_KEYID` can safely live in all three envs (they're inert without the URL); keeping them everywhere matches the rest of the secret-rotation surface and avoids special-casing later.

```bash
REPO=Cogni-DAO/cogni
KEYID=<keyid from step 2>
JWK=$(cat ~/.dolt/creds/$KEYID.jwk)
URL=https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator

# URL only in production — the writer-guard
gh secret set DOLTHUB_REMOTE_URL --repo $REPO --env production --body "$URL"

# Creds in all three so the doltgres entrypoint wrapper writes the file
# uniformly (no environment-conditional infra paths to maintain).
for ENV in candidate-a preview production; do
  gh secret set DOLT_CREDS_JWK   --repo $REPO --env $ENV --body "$JWK"
  gh secret set DOLT_CREDS_KEYID --repo $REPO --env $ENV --body "$KEYID"
done
```

Gate model: **secret-presence only**, matching the rest of the codebase (Langfuse, Privy, PostHog). The operator wires `pushMainOnMerge` if and only if `DOLTHUB_REMOTE_URL` resolves at startup. There is no `DEPLOY_ENVIRONMENT` runtime check — if you fat-finger the URL onto candidate-a/preview, it will push there. The discipline lives at the secret-scope layer; treat the prod environment scope as a privileged surface.

The bootstrap host can now delete its local `~/.dolt/creds/<keyid>.jwk` — the cluster has the only authoritative copy.

## Step 5 — Verify (after the next infra flight)

After `candidate-flight-infra.yml` next runs on a branch that includes this PR:

```bash
# SSH into the candidate-a VM
ssh root@<candidate-a-vm>
docker exec -it cogni-runtime-doltgres-1 ls -la /root/.dolt/creds/
# Should show <keyid>.jwk with perms 0600
docker exec -it cogni-runtime-doltgres-1 cat /root/.dolt/config_global.json
# Should show "user.creds":"<keyid>" alongside server_uuid
```

End-to-end push validation: merge any contribution via the inbox UI on candidate-a, then watch Loki for `msg="dolthub_push_ok"`. If you see `msg="dolthub_push_failed"`, the structured error includes the remote URL and the SQL error — usually means either the repo wasn't created (Step 1), the pubkey wasn't registered (Step 3), or the JWK was pasted truncated.

## What's wired by code (no manual steps)

| Surface                        | File                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Push SQL                       | `packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts`                        |
| Lazy `dolt_remote add`         | same — first push registers `origin` idempotently                                      |
| Service post-merge hook        | `packages/knowledge-store/src/service/contribution-service.ts` (`pushMainOnMerge` dep) |
| DI wire-up                     | `nodes/operator/app/src/bootstrap/container.ts` (`createDoltgresPusher`)               |
| Doltgres entrypoint wrapper    | `infra/compose/runtime/doltgres-init/install-creds.sh`                                 |
| Compose `entrypoint:` override | `infra/compose/runtime/docker-compose.yml` doltgres service                            |

When `DOLTHUB_REMOTE_URL` is unset, the push job is silently disabled — `pushMainOnMerge` is `undefined`, merges succeed locally with no remote attempt. This is the default for dev workspaces.

## Future work (v1+)

- **Service-account cred provisioning via OAuth client_credentials** — currently blocked on DoltHub OAuth app approval (task.5070). When approved, OAuth still won't sign push directly; it would need to mint a Dolt cred on behalf of the service. DoltHub does not expose this today.
- **Per-env separate creds** — for blast-radius isolation if any env's cred is compromised.
- **Automated repo creation** — DoltHub doesn't expose `POST /repos`; would require either DoltHub adding the API or a UI-scraping workaround. Out of scope.

## Why this can't be 100% automated yet

**Only the pubkey registration step (Step 3) is a manual UI paste.** Everything else — repo creation, keypair generation, secret provisioning — can be scripted with the PAT alone. DoltHub does not expose a REST endpoint to add a credential to an account; we verified across `POST /credentials`, `/user/credentials`, `/keys`, `/user/keys`, `/creds`, `/user/creds`, both `www.dolthub.com` and `dolthubapi.dolthub.com`, plus GraphQL — all 404 or 400-only-GET. Until DoltHub ships this, the bootstrap is a single 30-second UI action.

**The 30-second walkthrough** (for the human running this):

1. Open https://www.dolthub.com/settings/credentials (sign in with the `cogni` DoltHub account if not already)
2. Paste the pubkey printed by `dolt creds new` (or extracted from `.context/dolthub-bootstrap/pubkey.txt` if the agent staged it for you)
3. Click "Save"
4. Tell the agent it's done. Next merge fires `dolthub_push_ok` in Loki.

The human can be any agent maintainer (not Derek specifically). The pubkey is a per-environment service identity, not anyone's personal cred.
