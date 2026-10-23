---
name: validate-candidate
description: Validate a PR flighted to candidate-a with exact-SHA, behavior, authentication, UI/API and feature-specific Loki proof. Use for /validate-candidate, "prove this PR on candidate-a", or posting the PR validation scorecard. Fetch the authoritative hub contract first. Not for local tests or pre-flight CI.
---

# validate-candidate

The contract lives in [validate-candidate](https://cognidao.org/knowledge/validate-candidate), not in this file. This skill is only its trigger.

Read the full contract before validating. Use your saved Cogni key from `.env.cogni`:

```bash
set -o pipefail
: "${COGNI_NODE_API_KEY:?Load your saved Cogni API key from .env.cogni}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/validate-candidate \
  | jq -er '.content | select(type == "string" and length > 0)'
```

The hub owns the core axioms, workflow, scorecard, and future scenario-specific subatoms. Refine that authority instead of restoring procedural prose here. If recall fails, report the failure and retry before validating.
