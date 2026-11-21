#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Read-only identity gate called only by wait-for-in-cluster-services.sh.

Bind the selected artifact to the rendered promoted tree and current native
owners. Native reads use the existing trusted runner's transport, never a new
credential source. No endpoints, rollout writes or paid operations.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

IMAGE = "ghcr.io/cogni-dao/cogni-template"
WORKER = "operator-node-deploy-sequencer"
REVISION = "deployment.kubernetes.io/revision"
MANIFESTS = {"application/vnd.oci.image.manifest.v1+json",
             "application/vnd.docker.distribution.manifest.v2+json"}
INDEXES = {"application/vnd.oci.image.index.v1+json",
           "application/vnd.docker.distribution.manifest.list.v2+json"}
LIMIT = 8 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    with open(path, "rb") as handle:
        data = handle.read(LIMIT + 1)
    require(len(data) <= LIMIT, "input exceeds byte bound")
    return data


def run(argv, deadline, data=None):
    # File-backed output keeps native list/config reads out of unbounded RAM.
    with tempfile.TemporaryFile() as out:
        subprocess.run(argv, input=data, stdout=out, stderr=subprocess.DEVNULL,
                       check=True, timeout=max(.001, min(30, deadline - time.monotonic())))
        require(out.tell() <= LIMIT, "native output exceeds byte bound")
        out.seek(0)
        return out.read(LIMIT + 1)


def one(items, message):
    require(len(items) == 1, message)
    return items[0]


def declared(actual, expected):
    # Kubernetes defaults fields the rendered declaration omits.
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and declared(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(declared(a, e) for a, e in zip(actual, expected))
    return actual == expected


def container(subject):
    return one([c for c in subject["spec"]["containers"] if c["name"] == "sequencer"],
               "missing or ambiguous sequencer container")


def owned(obj, kind, owner):
    refs = [r for r in obj["metadata"].get("ownerReferences", []) if r.get("controller") is True]
    return len(refs) == 1 and all(refs[0].get(k) == v for k, v in
        {"kind": kind, "name": owner["metadata"]["name"], "uid": owner["metadata"]["uid"]}.items())


def live(obj):
    return bool(obj["metadata"].get("uid")) and not obj["metadata"].get("deletionTimestamp")


def manifest(digest, deadline):
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "invalid manifest digest")
    raw = run(["docker", "buildx", "imagetools", "inspect", "--raw", IMAGE + "@" + digest], deadline)
    # buildx can append a display newline; never reserialize JSON to invent a digest.
    candidates = [raw, raw[:-1]] if raw.endswith(b"\n") else [raw]
    require(any("sha256:" + hashlib.sha256(b).hexdigest() == digest for b in candidates),
            "registry manifest bytes do not match selected digest")
    value = json.loads(raw)
    require(value.get("schemaVersion") == 2, "unsupported manifest schema")
    return value


def verify_snapshot(items, expected, image, env, native, deadline):
    ns = "cogni-" + env
    deployment = one([i for i in items if i["kind"] == "Deployment" and
                      i["metadata"]["name"] == WORKER], "required deployment missing")
    require(live(deployment) and deployment["metadata"]["namespace"] == ns, "stale deployment")
    desired = expected["spec"].get("replicas", 1)
    spec, status = deployment["spec"], deployment["status"]
    require(type(desired) is int and desired > 0 and spec.get("replicas") == desired,
            "required worker has zero or wrong desired replicas")
    generation = deployment["metadata"]["generation"]
    require(generation > 0 and status.get("observedGeneration") == generation and
            all(status.get(k, 0) == desired for k in ["replicas", "updatedReplicas", "readyReplicas", "availableReplicas"]),
            "deployment generation/availability is not current")
    expected_container = container(expected["spec"]["template"])
    actual_container = container(spec["template"])
    require(declared(actual_container, expected_container), "deployment sequencer differs from rendered artifact")
    revision = deployment["metadata"].get("annotations", {}).get(REVISION)
    require(revision and re.fullmatch(r"[1-9][0-9]*", revision), "deployment revision missing")
    rs = one([i for i in items if i["kind"] == "ReplicaSet" and owned(i, "Deployment", deployment)
              and i["metadata"].get("annotations", {}).get(REVISION) == revision], "current owned ReplicaSet missing/ambiguous")
    require(live(rs) and rs["metadata"]["namespace"] == ns and rs["spec"].get("replicas") == desired and
            rs["status"].get("observedGeneration") == rs["metadata"]["generation"] and
            all(rs["status"].get(k, 0) == desired for k in ["replicas", "readyReplicas", "availableReplicas"]) and
            declared(container(rs["spec"]["template"]), expected_container), "ReplicaSet is stale, unready or wrong")
    pods = [i for i in items if i["kind"] == "Pod" and i.get("status", {}).get("phase") not in ["Succeeded", "Failed"]]
    require(all(owned(p, "ReplicaSet", rs) for p in pods), "stale or unowned sequencer pod remains")
    require(len(pods) == desired, "current owned pod count mismatch")
    selected_digest = image.split("@")[1]
    root = manifest(selected_digest, deadline)
    for pod in pods:
        require(live(pod) and pod["metadata"]["namespace"] == ns and pod["status"].get("phase") == "Running" and
                any(c.get("type") == "Ready" and c.get("status") == "True" for c in pod["status"].get("conditions", [])) and
                declared(container(pod), expected_container), "pod is stale, unready or wrong")
        state = one([c for c in pod["status"].get("containerStatuses", []) if c["name"] == "sequencer"],
                    "sequencer container status missing")
        require(state.get("ready") is True and state.get("state", {}).get("running") and
                state.get("containerID"), "sequencer container is not ready Running")
        node_name = pod["spec"]["nodeName"]
        require(re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", node_name), "invalid node name")
        node = native("get node " + node_name + " -o json")
        require(node["metadata"]["name"] == node_name and live(node), "node identity missing")
        info = node["status"]["nodeInfo"]
        require(info.get("containerRuntimeVersion", "").startswith("containerd://"), "unverified runtime imageID semantics")
        platform = {"os": info["operatingSystem"], "architecture": info["architecture"]}
        digest, selected = selected_digest, root
        if root.get("mediaType") in INDEXES:
            descriptor = one([m for m in root["manifests"] if all(m.get("platform", {}).get(k) == v for k, v in platform.items())],
                             "index platform is missing or ambiguous")
            require(descriptor.get("mediaType") in MANIFESTS, "unsupported platform descriptor")
            digest = descriptor["digest"]
            selected = manifest(digest, deadline)
        require(selected.get("mediaType") in MANIFESTS, "not an image manifest")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", selected["config"]["digest"]), "manifest config missing")
        config = json.loads(run(["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Image}}", IMAGE + "@" + digest], deadline))
        require(all(config.get(k) == v for k, v in platform.items()), "image config platform mismatch")
        # CRI containerd repo digests name manifests. Bare sha256/config IDs or
        # the parent index do not establish the selected platform manifest.
        image_id = state.get("imageID", "")
        require(image_id in [IMAGE + "@" + digest, "docker-pullable://" + IMAGE + "@" + digest],
                "runtime imageID does not identify selected platform manifest")
        require(state.get("containerID", "").startswith("containerd://"), "container runtime identity mismatch")
        print(f"sequencer pod={pod['metadata']['uid']} rs={rs['metadata']['uid']} deployment={deployment['metadata']['uid']} node={node_name} platform={platform} manifest={digest} imageID={image_id}")


def main():
    env = os.environ["DEPLOY_ENVIRONMENT"]
    require(env in ["candidate-a", "preview", "production"], "unsupported environment")
    deadline = time.monotonic() + max(1, int(os.environ.get("ROLLOUT_TIMEOUT", "300")))
    tree = Path(os.environ["OPERATOR_DEPLOY_ROOT"]).resolve()
    deploy_sha = os.environ["OPERATOR_DEPLOY_SHA"]
    require(re.fullmatch(r"[0-9a-f]{40}", deploy_sha), "deploy commit missing")
    require(run(["git", "-C", str(tree), "rev-parse", "HEAD"], deadline).decode().strip() == deploy_sha,
            "deploy tree does not match promoted commit")
    require(not run(["git", "-C", str(tree), "status", "--porcelain", "--untracked-files=all"], deadline).strip(), "promoted tree is dirty")
    if os.environ.get("OPERATOR_PAYLOAD_FILE"):
        payload = json.loads(read(os.environ["OPERATOR_PAYLOAD_FILE"]))
        target = one([t for t in payload["targets"] if t["target"] == "operator"], "selected operator payload missing/ambiguous")
        image, sha = target["digest"], target.get("source_sha") or payload.get("source_sha")
    else:
        image = read(os.environ["OPERATOR_SELECTED_DIGEST_FILE"]).decode().strip()
        sha = read(os.environ["OPERATOR_SELECTED_SOURCE_FILE"]).decode().strip()
    require(re.fullmatch(re.escape(IMAGE) + r"@sha256:[0-9a-f]{64}", image), "selected operator image missing/invalid")
    require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha), "selected operator source missing/invalid")
    require(json.loads(read(tree / ".promote-state/source-sha-by-app.json")).get("operator") == sha, "promoted source map differs from selected source")
    app_root = Path(os.environ["OPERATOR_APP_SOURCE_ROOT"]).resolve()
    app_sha = run(["git", "-C", str(app_root), "rev-parse", "HEAD"], deadline).decode().strip()
    if env == "candidate-a":
        require(app_sha == sha, "candidate app checkout differs from selected source")
    verifier_sha = run(["git", "-C", str(Path(__file__).resolve().parents[3]), "rev-parse", "HEAD"], deadline).decode().strip()
    print(f"sequencer verifier={__file__} workflow_ref={os.environ.get('GITHUB_REF', '')} workflow_checkout={verifier_sha} app_head={app_sha} selected_source={sha} deploy_commit={deploy_sha} artifact={image}", flush=True)
    overlay = tree / "infra/k8s/overlays" / env / "operator"
    images = json.loads(run(["yq", "-o=json", ".images", str(overlay / "kustomization.yaml")], deadline))
    pin = one([i for i in images if i["name"] == IMAGE], "promoted overlay image missing/ambiguous")
    require(pin.get("newName", IMAGE) + "@" + pin.get("digest", "") == image and "newTag" not in pin, "overlay differs from selected digest")
    rendered = run(["kubectl", "kustomize", str(overlay)], deadline)
    documents = json.loads(run(["yq", "eval-all", "-o=json", "-I=0", "[.]", "-"], deadline, rendered))
    require(isinstance(documents, list) and documents, "promoted render is empty")
    workers = [d for d in documents if d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == WORKER]
    if env == "preview":
        require(not workers, "preview unexpectedly declares a sequencer")
        print("sequencer: rendered preview topology intentionally has no worker")
        return
    expected = one(workers, "required sequencer missing from rendered topology")
    require(expected["metadata"].get("namespace") == "cogni-" + env and container(expected["spec"]["template"])["image"] == image,
            "rendered sequencer namespace/image mismatch")
    ssh = ["ssh", "-i", os.environ.get("SSH_KEY", str(Path.home() / ".ssh/deploy_key")),
           "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
           "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "root@" + os.environ["VM_HOST"]]

    def native(command):
        return json.loads(run(ssh + ["kubectl --request-timeout=10s -n cogni-" + env + " " + command], deadline))

    while True:
        try:
            snapshot = native("get deployment,replicaset,pod -l app.kubernetes.io/name=node-deploy-sequencer -o json")
            verify_snapshot(snapshot["items"], expected, image, env, native, deadline)
            return
        except (ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            if time.monotonic() >= deadline:
                raise ValueError("native sequencer identity unproven: " + str(error)) from error
            time.sleep(min(2, max(0, deadline - time.monotonic())))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        # No raw native output or runtime configuration is emitted on refusal.
        print("sequencer verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
