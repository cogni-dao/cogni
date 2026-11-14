# Knowledge hub offline recovery

Offline recovery: restore the Dolt knowledge hub when the hub is unreachable. This is the only runbook kept in the repo. Online detail, rationale and wiring live in the hub atom https://cognidao.org/knowledge/dolthub-mirror-bootstrap.

The hub is a Doltgres database. After every merged contribution the app pushes the canonical branch to its DoltHub mirror (`cogni-dao/<node>`), so the mirror is the recovery source.

## 1. Check the mirror is healthy (no node needed)

```bash
curl -s "https://www.dolthub.com/api/v1alpha1/cogni-dao/operator/main" | jq -r .query_execution_message
```

- `doltgres data is not supported` means healthy: go to step 2.
- `table has unknown fields` from web-SQL means a chunk is missing: stop and escalate.
- `branch not found` or `no such repository` means nothing was pushed: go to step 3.

## 2. Re-clone the hub from the mirror

Follow the `dolthub-local-clone` skill (`.claude/skills/dolthub-local-clone/SKILL.md`). It runs a throwaway Doltgres engine pinned to the fleet version in `infra/compose/runtime/docker-compose.yml` and calls `SELECT DOLT_CLONE('cogni-dao/<node>')`. Then restore the cloned database into the node's Doltgres and restart the node.

## 3. Re-create the mirror repo and push credentials (only when missing)

1. Create the repo (an existing repo returns "database already exists", which is safe):

```bash
curl -sS -X POST -H "authorization: token $DOLTHUB_API_TOKEN" -H "content-type: application/json" \
  -d '{"ownerName":"cogni-dao","repoName":"knowledge-operator","description":"Cogni operator knowledge mirror","visibility":"public"}' \
  "https://www.dolthub.com/api/v1alpha1/database"
```

2. Generate a Dolt cred on any host with the `dolt` CLI: `dolt creds new`. Keep the keyid and the contents of `~/.dolt/creds/<keyid>.jwk`.
3. Register the public key at https://www.dolthub.com/settings/credentials. This is UI-only; DoltHub has no REST endpoint for it.
4. Set `DOLT_CREDS_JWK` and `DOLT_CREDS_KEYID` for each GitHub Environment (`candidate-a`, `preview`, `production`) with `gh secret set ... --repo Cogni-DAO/cogni --env <env>`, then promote so the substrate lane renders them into the VM and recreates Doltgres.

The runtime remote comes from the node repo-spec `knowledge.remote.url` only. Without it, pushes are disabled and merges succeed locally.

## 4. Verify

Merge any contribution on the recovered node and watch Loki for `msg="dolthub_push_ok"`. `dolthub_push_failed` names the remote URL and SQL error; the usual causes are a missing repo (step 3.1), an unregistered public key (step 3.3), or a truncated JWK.
