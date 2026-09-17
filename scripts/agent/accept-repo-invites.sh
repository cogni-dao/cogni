#!/usr/bin/env bash
# Session-start GitHub-push self-heal (bug.5114).
#
# The operator App grants a developer branch-push by ADDING the agent's GitHub
# identity as a collaborator (github-repo-write.ts:setNodeCollaborator). For an
# outside collaborator (a non-org agent such as flock-leader) GitHub creates a
# PENDING invitation and keeps repo `push:false` until the *invitee* accepts it
# with its own token — `PATCH /user/repository_invitations/{id}`. The operator
# App cannot do this (it is not the invitee), and rbac.md §6 step 5's
# "agent auto-accepts with its own token" was never implemented, so every fleet
# reprovision/key-cycle that re-issues the invite silently drops the agent to
# push:false. This script IS that missing accept step: idempotent, non-fatal,
# run on every session start. It only touches invitations into the trusted
# `Cogni-DAO` org — never an arbitrary third-party invite.
set -u

TRUSTED_ORG="Cogni-DAO"

# gh is the invitee's authenticated identity; if it is absent or unauthenticated
# there is nothing to self-heal here — stay silent and non-fatal.
command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

pending="$(gh api /user/repository_invitations 2>/dev/null \
  | jq -c --arg org "$TRUSTED_ORG" \
      '[.[] | select((.repository.owner.login | ascii_downcase) == ($org | ascii_downcase))
             | {id, repo: .repository.full_name}]' 2>/dev/null)"

# No gh output, no jq, or no pending trusted invites → nothing to do, quietly.
[ -n "${pending:-}" ] || exit 0
count="$(printf '%s' "$pending" | jq 'length' 2>/dev/null || echo 0)"
[ "${count:-0}" -gt 0 ] || exit 0

printf '%s' "$pending" | jq -r '.[] | "\(.id)\t\(.repo)"' | while IFS="$(printf '\t')" read -r id repo; do
  [ -n "$id" ] || continue
  if gh api --method PATCH "/user/repository_invitations/${id}" >/dev/null 2>&1; then
    echo "accepted GitHub write invite: ${repo} (push self-healed, bug.5114)"
  else
    # Non-fatal: a stale/expired invite id is fine to skip — GitHub 404s it.
    echo "note: could not accept invite ${id} for ${repo} (likely already accepted/expired)"
  fi
done

exit 0
