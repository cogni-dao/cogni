# Node Template Candidate Validation

Use candidate-a deployments at `https://<node>-test.cognidao.org`.

Captured browser auth state belongs at:

```text
.local-auth/candidate-a-<node>.storageState.json
```

Minted nodes from this template are node-at-root apps. Validate human-axis routes from the site root, not from `/nodes/<slug>`:

- `/`
- `/chat`
- `/dashboard`
- `/credits`
- `/activity`

For agent-axis validation, inspect the actual OpenAPI output and route files before probing endpoints. Do not infer route availability from another node.

Most `/api/v1/*` routes require captured session cookies or an agent token. Public unauthenticated routes live under `/api/v1/public/*`.

For Loki checks, query namespace `cogni-candidate-a` and pods matching:

```text
<node>-node-app-.*
```
