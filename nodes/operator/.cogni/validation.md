# Operator Validation Guide

Use this file during `/validate-candidate` after identifying `operator` as impacted.
The operator is both the root app and the node registry/gallery host, so it has
one route shape that other nodes do not.

## Candidate URL

- `candidate-a` base URL: `https://test.cognidao.org`
- Captured auth state: `.local-auth/candidate-a-operator.storageState.json`

## Human-Axis Routes

- Public landing page: `/`
- Primary signed-in app page: `/chat`
- Operator's node detail page: `/nodes/operator`
- Node gallery page: `/nodes`
- Dashboard page: `/dashboard`
- Knowledge pages: `/knowledge`, `/knowledge/<id>`

Only the operator validates its own node detail at `/nodes/operator`. Other
nodes are node-at-root apps and validate their root/app pages on their own
subdomain unless their local guide says otherwise.

## Auth Routing

- Read `.claude/skills/operator-app-auth-routing/SKILL.md` before validating
  operator route group, proxy, public chrome, `/nodes`, `/dashboard`,
  `/knowledge`, or Connect/account-menu behavior changes.
- `/nodes` and `/nodes/[slug]` are public but auth-aware.
- `(app)` pages must be protected by `nodes/operator/app/src/proxy.ts`.
- Signed-in users visiting `/` should redirect to `/chat`.
- Signed-out users visiting protected pages should redirect to `/`.

## Agent-Axis Routes

- Operator API routes under `/api/v1/*` require either a NextAuth session or a
  valid agent token, except `/api/v1/public/*` and explicit proxy exceptions.
- Validate route auth behavior from `nodes/operator/app/src/proxy.ts` and the
  route handler itself; the proxy is only early rejection.

## Loki

- Namespace: `cogni-candidate-a`
- Pod selector: `operator-node-app-.*`
- Prefer route-specific markers, request ids, or user-correlated events over
  ambient `/nodes` or `/dashboard` traffic.
