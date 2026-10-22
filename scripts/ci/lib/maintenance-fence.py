#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Per-node deploy fence and finite owner claim; never clears maintenance intent."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

MARKER = ".promote-state/maintenance-drain.json"
RECEIPT = ".promote-state/maintenance-drain-receipt.json"


def read_present(root, relative):
    path = Path(root) / relative
    if not os.path.lexists(path):
        return None
    if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
        raise RuntimeError("maintenance_guard_file_unproven")
    if path.stat().st_size > 65536:
        raise RuntimeError("maintenance_guard_file_unproven")
    try:
        value = json.loads(path.read_text())
    except (ValueError, OSError):
        raise RuntimeError("maintenance_guard_json_invalid") from None
    # A PRESENT JSON null is never an absent marker.
    if not isinstance(value, dict) or not value:
        raise RuntimeError("maintenance_guard_shape_invalid")
    return value


def compare_source(repository, base, head):
    value = subprocess.check_output(
        ["gh", "api", f"repos/{repository}/compare/{base}...{head}", "--jq", ".status"],
        text=True, stderr=subprocess.PIPE, timeout=30,
        env={**os.environ, "GH_TOKEN": os.environ.get("SOURCE_READ_TOKEN") or os.environ.get("GH_TOKEN", "")},
    ).strip()
    if value not in ("ahead", "behind", "identical", "diverged"):
        raise RuntimeError("maintenance_floor_comparison_unknown")
    return value


def check(root, repository=None, source_sha=None, compare=None):
    marker = read_present(root, MARKER)
    if marker is not None:
        if marker.get("phase") == "qualifying":
            check_qualification(marker, repository, source_sha, root=root)
            receipt = read_present(root, RECEIPT)
            if receipt is not None:
                check_receipt(receipt, repository, source_sha, compare)
            return
        # Other maintenance phases remain closed to ordinary delivery.
        raise RuntimeError("maintenance_drain_active")
    receipt = read_present(root, RECEIPT)
    if receipt is None:
        return
    check_receipt(receipt, repository, source_sha, compare)


def check_qualification(marker, repository, source_sha, *, root=None,
                        environment=None, now=None, require_owner=True):
    """Consume a maintainer-bound ALREADY ACTIVE source; never authorize first DML.

    The finite owning maintainer first proves old-provider/native absence and
    atomically activates the exact artifact. This grant only lets its normal
    flight reapply that same artifact before a truthful post-merge floor exists.
    """
    env = os.environ if environment is None else environment
    request = marker.get("request", {})
    grant = marker.get("qualification", {})
    valid_sha = lambda value: isinstance(value, str) and bool(re.fullmatch(r"[a-f0-9]{40}", value))
    valid_digest = lambda value: isinstance(value, str) and bool(re.fullmatch(r"[a-f0-9]{64}", value))
    if (marker.get("version") != 1 or marker.get("phase") != "qualifying"
            or not valid_digest(marker.get("operationId"))
            or request.get("nodeId") != "b927a9dd-6132-4fc9-a51e-e3cee2568e3c"
            or request.get("slug") != "node-template" or request.get("env") != "candidate-a"
            or repository != "cogni-dao/node-template"
            or request.get("sourceRepository") != repository
            or not valid_sha(source_sha) or request.get("sourceSha") != source_sha
            or grant.get("phase") != "active" or not valid_sha(grant.get("activationHead"))
            or not valid_digest(grant.get("manifestSha256"))
            or not valid_digest(grant.get("nativeAuditDigest"))
            or not valid_digest(grant.get("providerClosureDigest"))
            or not valid_digest(grant.get("sourceExclusionDigest"))
            or not isinstance(grant.get("bundleDigest"), str)
            or not re.fullmatch(r"ghcr.io/cogni-dao/node-template@sha256:[a-f0-9]{64}", grant["bundleDigest"])
            or not isinstance(grant.get("imageDigest"), str)
            or not re.fullmatch(r"ghcr.io/cogni-dao/node-template@sha256:[a-f0-9]{64}", grant["imageDigest"])
            or env.get("GITHUB_REPOSITORY") != "cogni-dao/cogni"
            or not isinstance(grant.get("workflowRef"), str)
            or not grant["workflowRef"].startswith("cogni-dao/cogni/.github/workflows/candidate-flight.yml@refs/")
            or grant["workflowRef"] != env.get("GITHUB_WORKFLOW_REF")
            or grant.get("workflowSha") != env.get("GITHUB_WORKFLOW_SHA")
            or not valid_sha(grant.get("workflowSha"))
            or env.get("DEPLOY_ENVIRONMENT") != "candidate-a"
            or env.get("NODE") != "node-template"
            or env.get("PER_NODE_BRANCH") != "deploy/candidate-a-node-template"
            or env.get("GITHUB_JOB") not in ("external-node-preflight", "prepare-substrate-deploy-branch", "flight")):
        raise RuntimeError("maintenance_qualification_identity_unproven")
    try:
        deadline = datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00"))
        issued = datetime.fromisoformat(grant["issuedAt"].replace("Z", "+00:00"))
        current = now or datetime.now(timezone.utc)
        if not (issued <= current < deadline and 0 < (deadline-issued).total_seconds() <= 7200):
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise RuntimeError("maintenance_qualification_expired") from None
    owner = {"runId": env.get("GITHUB_RUN_ID"), "runAttempt": env.get("GITHUB_RUN_ATTEMPT")}
    if any(not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value) for value in owner.values()):
        raise RuntimeError("maintenance_qualification_owner_unproven")
    if grant.get("owner") != owner and (require_owner or grant.get("owner") is not None):
        raise RuntimeError("maintenance_qualification_owner_mismatch")
    if root is not None:
        subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", grant["activationHead"], "HEAD"],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        manifest = Path(root)/"infra/k8s/overlays/candidate-a/node-template/xcomputeworkload.yaml"
        if manifest.is_symlink() or not manifest.is_file() or hashlib.sha256(manifest.read_bytes()).hexdigest() != grant["manifestSha256"]:
            raise RuntimeError("maintenance_qualification_artifact_mismatch")
        value = json.loads(subprocess.check_output(["yq", "-o=json", str(manifest)], stderr=subprocess.PIPE, timeout=15))
        spec = value.get("spec", {})
        bundle = spec.get("bundle", {})
        artifacts = bundle.get("artifacts", [])
        if (value.get("kind") != "XComputeWorkload"
                or value.get("metadata", {}).get("namespace") != "cogni-candidate-a"
                or spec.get("nodeId") != request["nodeId"]
                or spec.get("environment") != request["env"]
                or bundle.get("source") != {"repository": repository, "sha": source_sha}
                or bundle.get("ref") != grant["bundleDigest"]
                or len(artifacts) != 1 or artifacts[0].get("image") != grant["imageDigest"]):
            raise RuntimeError("maintenance_qualification_artifact_mismatch")
    return grant


def claim_qualification(root, repository, source_sha):
    """First normal App writer claims the finite grant with an exact remote-head CAS."""
    marker = read_present(root, MARKER)
    if marker is None or marker.get("phase") != "qualifying":
        check(root, repository, source_sha)
        return
    if os.environ.get("GITHUB_JOB") != "prepare-substrate-deploy-branch":
        raise RuntimeError("maintenance_qualification_claim_job_refused")
    grant = check_qualification(marker, repository, source_sha, root=root, require_owner=False)
    receipt = read_present(root, RECEIPT)
    if receipt is not None:
        check_receipt(receipt, repository, source_sha)
    if grant.get("owner") is not None:
        return
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.PIPE, timeout=30).strip()
    branch = "deploy/candidate-a-node-template"
    head = git("rev-parse", "HEAD")
    remote = git("ls-remote", "origin", f"refs/heads/{branch}").split()
    if len(remote) != 2 or remote[0] != head:
        raise RuntimeError("maintenance_qualification_head_changed")
    grant["owner"] = {"runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"]}
    Path(root, MARKER).write_text(json.dumps(marker, sort_keys=True)+"\n")
    git("add", "--", MARKER)
    git("commit", "-m", "maintenance node-template: claim exact qualification owner")
    git("push", f"--force-with-lease=refs/heads/{branch}:{head}", "origin", f"HEAD:refs/heads/{branch}")


def preserve_qualification(root, repository, source_sha):
    """Shape preparation must not replace the maintainer's exact activated APP."""
    marker = read_present(root, MARKER)
    if marker is None or marker.get("phase") != "qualifying":
        check(root, repository, source_sha)
        return
    grant = check_qualification(marker, repository, source_sha)
    for name in ("xcomputeworkload.yaml", "kustomization.yaml"):
        relative = f"infra/k8s/overlays/candidate-a/node-template/{name}"
        content = subprocess.check_output(["git", "-C", str(root), "show", f"{grant['activationHead']}:{relative}"],
                                          stderr=subprocess.PIPE, timeout=15)
        destination = Path(root, relative)
        if destination.is_symlink() or destination.parent.is_symlink():
            raise RuntimeError("maintenance_guard_file_unproven")
        destination.write_bytes(content)
    check(root, repository, source_sha)


def check_receipt(receipt, repository=None, source_sha=None, compare=None):
    """The same read-only floor check for a pinned remote deployment snapshot."""
    request = receipt.get("request")
    if not isinstance(request, dict):
        raise RuntimeError("maintenance_compatibility_floor_invalid")
    floor_repository = request.get("sourceRepository")
    floor_sha = request.get("sourceSha")
    if (receipt.get("version") != 1 or receipt.get("phase") != "audited"
            or not re.fullmatch(r"[a-f0-9]{64}", receipt.get("operationId", ""))
            or not isinstance(floor_repository, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", floor_repository)
            or repository != floor_repository
            or not isinstance(floor_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", floor_sha)
            or not isinstance(source_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", source_sha)):
        raise RuntimeError("maintenance_compatibility_floor_invalid")
    compare = compare or compare_source
    # Squash merge breaks PR-head ancestry. A durable floor must first be
    # reachable from the owning repository's actual main, never a premerge head.
    if compare(repository, floor_sha, "main") not in ("ahead", "identical"):
        raise RuntimeError("maintenance_floor_not_on_main")
    if source_sha != floor_sha and compare(repository, floor_sha, source_sha) != "ahead":
        raise RuntimeError("maintenance_compatibility_floor_violation")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ("check", "claim", "preserve"):
            raise RuntimeError("maintenance_guard_check_only")
        action = {"check": check, "claim": claim_qualification, "preserve": preserve_qualification}[sys.argv[1]]
        action(sys.argv[2], os.environ.get("SOURCE_REPOSITORY"), os.environ.get("SOURCE_SHA"))
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r"maintenance_[a-z0-9_]+", message) else "maintenance_guard_unavailable", file=sys.stderr)
        sys.exit(1)
