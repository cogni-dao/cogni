# GitHub Org Rename Cutover

## Purpose

Prepare the repo for renaming the GitHub organization from `Cogni-DAO` to `cogni-dao`.

## Cutover Order

1. Rename the GitHub organization in GitHub settings.
2. Confirm the canonical repo resolves:

   ```bash
   gh api repos/cogni-dao/cogni --jq .full_name
   git ls-remote --heads https://github.com/cogni-dao/cogni.git main
   ```

3. Review GitHub repository and environment variables/secrets for old owner values.
   At minimum check `GH_REPOS`, any `COGNI_REPO_URL` overrides, and any PAT-scoped
   variables whose description or value names `Cogni-DAO`.
   Note: `NODE_MINT_OWNER`, `NODE_TEMPLATE_OWNER`, and `NODE_SUBMODULE_PARENT_OWNER`
   are NOT GitHub variables — they are committed prod ConfigMap values in
   `infra/k8s/overlays/production/operator/kustomization.yaml` (pinned to the
   canonical owner by this PR and the org-rename CI invariant); changing GitHub
   repository variables of the same name will not affect the running operator pod.
4. Merge the org-rename config PR.
5. Update local remotes:

   ```bash
   git remote set-url origin https://github.com/cogni-dao/cogni.git
   ```

6. Run the normal CI and candidate-flight validation path before treating the cutover as complete.

## Notes

GitHub redirects old repository URLs, but API callers, CODEOWNERS mentions, and configured variables/secrets should use the new canonical owner.
