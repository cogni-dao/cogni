#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Candidate worker rollout is not sufficient: prove the internal /version SHA
# and digest gate succeeds exact and fails closed on a stale digest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VERIFY="$REPO_ROOT/scripts/ci/wait-for-in-cluster-services.sh"
TMPROOT="$(mktemp -d -t wait-worker.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

cat >"$TMPROOT/ssh" <<'SH'
#!/usr/bin/env bash
command="${*: -1}"
case "$command" in
  *"get deploy scheduler-worker"*) printf '1 1 1 1 1 5\n' ;;
  *"get rs -o json"*) printf '1\n' ;;
  *"get pods -l app.kubernetes.io/name=scheduler-worker"*) printf '10.0.0.1\t%s\n' "${FAKE_WORKER_VERSION:?}" ;;
  *) echo "unexpected ssh command: $command" >&2; exit 1 ;;
esac
SH
chmod +x "$TMPROOT/ssh"

SHA="1111111111111111111111111111111111111111"
DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

PATH="$TMPROOT:$PATH" \
FAKE_WORKER_VERSION="{\"sha\":\"$SHA\",\"imageDigest\":\"$DIGEST\"}" \
VM_HOST=fake DEPLOY_ENVIRONMENT=candidate-a PROMOTED_APPS=scheduler-worker \
SCHEDULER_EXPECTED_SHA="$SHA" SCHEDULER_EXPECTED_DIGEST="$DIGEST" \
ROLLOUT_TIMEOUT=1 bash "$VERIFY" >/dev/null

if PATH="$TMPROOT:$PATH" \
  FAKE_WORKER_VERSION="{\"sha\":\"$SHA\",\"imageDigest\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}" \
  VM_HOST=fake DEPLOY_ENVIRONMENT=candidate-a PROMOTED_APPS=scheduler-worker \
  SCHEDULER_EXPECTED_SHA="$SHA" SCHEDULER_EXPECTED_DIGEST="$DIGEST" \
  ROLLOUT_TIMEOUT=0 bash "$VERIFY" >/dev/null 2>&1; then
  echo "FAIL: stale scheduler-worker /version digest passed" >&2
  exit 1
fi

echo "PASS: scheduler-worker /version identity is exact and fail-closed"

# Exercise the native verifier CLI through mocked tools. No infrastructure is
# reachable: every transport/render/OCI tool is a local executable fixture.
python3 - "$REPO_ROOT" "$TMPROOT" <<'PY'
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

repo, tmp = map(Path, sys.argv[1:])
fixtures = tmp / "native"
fixtures.mkdir()
bin_dir = fixtures / "bin"
bin_dir.mkdir()
mock = bin_dir / "native-tool"
mock.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
p=pathlib.Path(os.environ["NATIVE_FIXTURE"])
d=json.loads((p/"native.json").read_text()); name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
if name=="git":
 if "rev-parse" in args: print(d["deploySha"])
 elif "status" in args: print(d.get("dirty", ""),end="")
 else: sys.exit(91)
elif name=="kubectl":
 if args[0]!="kustomize" or d.get("renderFails"): sys.exit(92)
 print("rendered fixture")
elif name=="yq":
 print(json.dumps(d["rendered"] if "eval-all" in args else d["images"]))
elif name=="docker":
 if "--raw" in args:
  digest=args[-1].split("@")[-1]
  print(d["manifests"][digest],end="")
 else: print(json.dumps(d["config"]))
elif name=="ssh":
 command=args[-1]
 if "get deployment,replicaset,pod" in command: print(json.dumps({"items":d["items"]}))
 elif "get node " in command: print(json.dumps(d["node"]))
 else: sys.exit(93)
else: sys.exit(94)
''')
mock.chmod(0o755)
for name in ["git", "kubectl", "yq", "docker", "ssh"]:
    (bin_dir / name).symlink_to(mock)

sha = "1" * 40
image = "ghcr.io/cogni-dao/cogni-template"
worker = "operator-node-deploy-sequencer"
revision = "deployment.kubernetes.io/revision"
manifest_type = "application/vnd.oci.image.manifest.v1+json"
index_type = "application/vnd.oci.image.index.v1+json"
manifest = json.dumps({"schemaVersion": 2, "mediaType": manifest_type,
    "config": {"digest": "sha256:" + "c" * 64}, "layers": []})
digest = "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()
index = json.dumps({"schemaVersion": 2, "mediaType": index_type,
    "manifests": [{"mediaType": manifest_type, "digest": digest,
        "platform": {"os": "linux", "architecture": "amd64"}}]})
index_digest = "sha256:" + hashlib.sha256(index.encode()).hexdigest()


def fixture(env="candidate-a", indexed=False):
    selected = index_digest if indexed else digest
    ref = image + "@" + selected
    ns = "cogni-" + env
    c = {"name": "sequencer", "image": ref,
         "command": ["node", "/app/nodes/operator/app/node-deploy-sequencer.mjs"]}
    template = {"spec": {"containers": [c]}}
    deployment = {"kind": "Deployment", "metadata": {"name": worker,
        "namespace": ns, "uid": "deploy-current", "generation": 4,
        "annotations": {revision: "7"}}, "spec": {"replicas": 1, "template": template},
        "status": {"observedGeneration": 4, "replicas": 1, "updatedReplicas": 1,
            "readyReplicas": 1, "availableReplicas": 1}}
    rs = {"kind": "ReplicaSet", "metadata": {"name": worker + "-new",
        "namespace": ns, "uid": "rs-current", "generation": 1,
        "annotations": {revision: "7"}, "ownerReferences": [{"kind": "Deployment",
            "name": worker, "uid": "deploy-current", "controller": True}]},
        "spec": {"replicas": 1, "template": copy.deepcopy(template)},
        "status": {"observedGeneration": 1, "replicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
    pod = {"kind": "Pod", "metadata": {"name": "worker-pod", "namespace": ns,
        "uid": "pod-current", "ownerReferences": [{"kind": "ReplicaSet",
            "name": worker + "-new", "uid": "rs-current", "controller": True}]},
        "spec": {"containers": [copy.deepcopy(c)], "nodeName": "node-a"},
        "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
            "containerStatuses": [{"name": "sequencer", "ready": True,
                "state": {"running": {"startedAt": "2026-11-21T00:00:00Z"}},
                "containerID": "containerd://actual-container", "imageID": image + "@" + digest}]}}
    expected = copy.deepcopy(deployment)
    # Real API defaults must not invalidate an otherwise exact declaration.
    for obj in [deployment["spec"]["template"], rs["spec"]["template"], pod]:
        obj["spec"]["containers"][0]["terminationMessagePath"] = "/dev/termination-log"
    return {"deploySha": sha, "images": [{"name": image, "digest": selected}],
        "rendered": [expected] if env != "preview" else [{"kind": "ConfigMap"}],
        "items": [deployment, rs, pod], "manifests": {digest: manifest, index_digest: index},
        "config": {"os": "linux", "architecture": "amd64"},
        "node": {"metadata": {"name": "node-a", "uid": "node-current"}, "status": {
            "nodeInfo": {"operatingSystem": "linux", "architecture": "amd64", "containerRuntimeVersion": "containerd://2.0.0"}}}}


def check(name, data, passes=False, env="candidate-a", payload=True):
    (fixtures / "native.json").write_text(json.dumps(data))
    state_dir = fixtures / ".promote-state"
    state_dir.mkdir(exist_ok=True)
    (state_dir / "source-sha-by-app.json").write_text(json.dumps({"operator": data.get("mapSha", sha)}))
    ref = image + "@" + data["images"][0]["digest"]
    selected = data.get("selected", ref)
    (fixtures / "payload.json").write_text(json.dumps({"source_sha": sha, "targets": [{"target": "operator", "digest": selected}]}))
    (fixtures / "selected-digest").write_text(selected)
    (fixtures / "selected-source").write_text(sha)
    environ = {**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"],
        "NATIVE_FIXTURE": str(fixtures), "DEPLOY_ENVIRONMENT": env,
        "OPERATOR_DEPLOY_ROOT": str(fixtures), "OPERATOR_DEPLOY_SHA": sha,
        "OPERATOR_APP_SOURCE_ROOT": str(fixtures), "VM_HOST": "fake",
        "ROLLOUT_TIMEOUT": "0"}
    if payload:
        environ["OPERATOR_PAYLOAD_FILE"] = str(fixtures / "payload.json")
    else:
        environ.pop("OPERATOR_PAYLOAD_FILE", None)
        environ["OPERATOR_SELECTED_DIGEST_FILE"] = str(fixtures / "selected-digest")
        environ["OPERATOR_SELECTED_SOURCE_FILE"] = str(fixtures / "selected-source")
    result = subprocess.run(["python3", str(repo / "scripts/ci/lib/verify-sequencer.py")],
                            env=environ, capture_output=True, text=True, timeout=12)
    if (result.returncode == 0) != passes:
        raise AssertionError(name + "\n" + result.stdout + result.stderr)
    print("PASS: " + name)


check("valid manifest", fixture(), True)
check("valid OCI index resolves platform manifest", fixture(indexed=True), True)
check("production selected cell artifact", fixture("production", True), True, "production", False)
check("preview declared worker absence", fixture("preview"), True, "preview", False)

cases = {
    "missing required rendered worker": lambda d: d.update(rendered=[{"kind": "ConfigMap"}]),
    "failed render": lambda d: d.update(renderFails=True),
    "missing deployment": lambda d: d["items"].pop(0),
    "zero replicas": lambda d: d["items"][0]["spec"].update(replicas=0),
    "stale generation": lambda d: d["items"][0]["status"].update(observedGeneration=3),
    "stale RS owner UID": lambda d: d["items"][1]["metadata"]["ownerReferences"][0].update(uid="old-deployment"),
    "stale RS revision": lambda d: d["items"][1]["metadata"]["annotations"].update({revision: "6"}),
    "stale pod owner UID": lambda d: d["items"][2]["metadata"]["ownerReferences"][0].update(uid="old-rs"),
    "missing pod": lambda d: d["items"].pop(),
    "missing container status": lambda d: d["items"][2]["status"].update(containerStatuses=[]),
    "unready container": lambda d: d["items"][2]["status"]["containerStatuses"][0].update(ready=False),
    "waiting container": lambda d: d["items"][2]["status"]["containerStatuses"][0].update(state={"waiting": {}}),
    "terminating pod": lambda d: d["items"][2]["metadata"].update(deletionTimestamp="now"),
    "non-running pod": lambda d: d["items"][2]["status"].update(phase="Pending"),
    "wrong deployment image": lambda d: d["items"][0]["spec"]["template"]["spec"]["containers"][0].update(image="wrong"),
    "wrong runtime image": lambda d: d["items"][2]["status"]["containerStatuses"][0].update(imageID=image + "@sha256:" + "b"*64),
    "ambiguous bare config ID": lambda d: d["items"][2]["status"]["containerStatuses"][0].update(imageID="sha256:" + "c"*64),
    "wrong node platform": lambda d: d["node"]["status"]["nodeInfo"].update(architecture="arm64"),
    "wrong config platform": lambda d: d["config"].update(architecture="arm64"),
    "wrong selected payload": lambda d: d.update(selected=image + "@sha256:" + "b"*64),
    "missing source map": lambda d: d.update(mapSha=None),
    "inconsistent source map": lambda d: d.update(mapSha="2"*40),
    "wrong deploy commit": lambda d: d.update(deploySha="2"*40),
    "dirty promoted tree": lambda d: d.update(dirty=" M infra/overlay"),
    "unverifiable runtime": lambda d: d["node"]["status"]["nodeInfo"].update(containerRuntimeVersion="unknown://1"),
    "unready RS": lambda d: d["items"][1]["status"].update(availableReplicas=0),
    "unready pod": lambda d: d["items"][2]["status"].update(conditions=[]),
    "mismatched manifest bytes": lambda d: d["manifests"].update({digest: "{}"}),
}
for name, mutate in cases.items():
    data = fixture()
    mutate(data)
    check(name, data)
data = fixture(indexed=True)
data["items"][2]["status"]["containerStatuses"][0]["imageID"] = image + "@" + index_digest
check("index is not a runtime platform manifest", data)
data = fixture("preview")
data["rendered"] = fixture("preview")["items"][:1]
check("unexpected preview sequencer", data, env="preview", payload=False)
PY
