#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Purpose: Validate selected nonsecret runtime facts before optional TEST DNS publication.
# Scope: Owned receipts and read-only public DNS. Does not mutate desired state or read credential values.
import hashlib
import json
import re
import subprocess
import sys

receipt_path, facts_path = sys.argv[1:]
with open(receipt_path, encoding="utf-8") as handle:
    receipt = json.load(handle)
with open(facts_path, encoding="utf-8") as handle:
    facts = json.load(handle)
receipt["facts"] = facts
receipt["status"] = "failure"
errors = []

def require(condition, reason):
    if not condition:
        errors.append(reason)

def ready(resource, kind):
    return any(c.get("type") == kind and c.get("status") == "True" for c in (resource.get("conditions") or []))

def has_read_error(value):
    if isinstance(value, dict):
        return value.get("readError") is True or any(has_read_error(v) for v in value.values())
    if isinstance(value, list):
        return any(has_read_error(v) for v in value)
    return False

require(not has_read_error(facts), "runtime resource read failed; absence unresolved")

node, env = receipt["node"], receipt["environment"]
repo_url = "https://github.com/" + receipt["repository"] + ".git"
branch = "deploy/" + env + "-" + node
require(receipt["zoneId"] == receipt["configuredZoneId"] and receipt["zoneId"] != "0" * 32, "configured TEST zone disagreement")
require(ready(facts["crd"], "Established"), "Request CRD not Established")
require(ready(facts["provider"], "Healthy") and ready(facts["provider"], "Installed"), "provider-http not ready")
require(facts["provider"].get("package", "").endswith("@sha256:53ff679013f4787fcb00c7d36fd4520340543f9ebd35bef581eed42c37d7c5b6"), "provider-http package differs from reviewed pin")
require(facts["config"].get("source") == "None", "unexpected provider credentials source")
require(ready(facts["eso"], "Ready") and facts["keyPresent"] is True, "operator ESO/token key not ready")
appset, app = facts["appset"], facts["app"]
# Compare the ENTIRE admitted spec, including unknown override fields. No API
# defaults are normalized: an observed default needs explicit source review.
require(bool(receipt.get("expectedAppSetSpecHash")) and appset.get("specHash") == receipt.get("expectedAppSetSpecHash"), "ApplicationSet whole spec differs from shared TEST declaration")
require(bool(appset.get("uid")) and appset.get("name") == "cogni-" + env + "-" + node, "ApplicationSet identity unresolved")
authorities = facts.get("appsetAuthorities")
require(isinstance(authorities, list), "AppSet managing authority read unresolved")
def authority_hash(value):
    return hashlib.sha256((json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
for authority in authorities or []:
    require(authority.get("sourcesPresent") is False and authority.get("sourceHash") == authority_hash({"repoURL":repo_url,"targetRevision":"main","path":"infra/k8s/argocd/appsets/" + env}) and authority.get("destinationHash") == authority_hash({"server":"https://kubernetes.default.svc","namespace":"argocd"}), "foreign or overridden Argo Application claims TEST AppSet")
tracking_owner = (appset.get("tracking") or "").split(":")[0] or appset.get("argoInstance")
if tracking_owner:
    require(any(a.get("name") == tracking_owner for a in (authorities or [])), "AppSet tracking authority unresolved")
if app.get("name"):
    require(any(o.get("kind") == "ApplicationSet" and o.get("uid") == appset.get("uid") and o.get("name") == appset.get("name") for o in (app.get("ownerReferences") or [])), "Application not owned by expected ApplicationSet")
    require(app.get("name") == env + "-" + node and bool(receipt.get("expectedApplicationSpecHash")) and app.get("specHash") == receipt.get("expectedApplicationSpecHash"), "Application whole spec differs from shared TEST declaration")
dep = facts["deployment"]
if dep.get("name"):
    require(app.get("name") == env + "-" + node and any(r.get("kind") == "Deployment" and r.get("name") == node + "-node-app" and r.get("namespace") == "cogni-" + env for r in (app.get("resources") or [])), "existing Deployment writer unresolved")
    require(dep.get("instance") == node, "Deployment target identity mismatch")
if facts["service"].get("name"):
    require((facts["service"].get("selector") or {}).get("app.kubernetes.io/instance") == node, "Service selector mismatch")
# A stale/unready workload is a recorded rollout input, not a bootstrap deadlock.
# The proven TEST writer may repair it; final public readiness remains mandatory.
receipt["workloadReadiness"] = {
    "applicationPresent": bool(app.get("name")),
    "deploymentPresent": bool(dep.get("name")),
    "availableReplicas": (dep.get("status") or {}).get("availableReplicas", 0),
    "readyEndpointCount": sum(e.get("conditions", {}).get("ready") is True for s in facts["endpoints"] for e in s.get("endpoints", [])),
}
request = facts.get("dnsRequest")
if request is not None:
    require(request.get("owner") == receipt["owner"], "existing Request owner mismatch")
elif not errors:
    # First publication may only claim an unoccupied public hostname. This is
    # read-only DNS; fixed CNAME POST still provides the atomic no-upsert fence.
    receipt["dnsQueries"] = {}
    for record_type in ["A", "AAAA", "CNAME", "TXT", "MX", "NS"]:
        try:
            result = subprocess.run(["dig", "+time=3", "+tries=1", "+noall", "+comments", "+answer", receipt["host"], record_type], capture_output=True, text=True, timeout=5, check=False)
            output = result.stdout
            receipt["dnsQueries"][record_type] = output
            match = re.search(r"status: ([A-Z]+)", output)
            answers = [line for line in output.splitlines() if line.strip() and not line.startswith(";")]
            require(result.returncode == 0 and match is not None and match[1] in ["NXDOMAIN", "NOERROR"] and not answers, "public hostname occupied/unknown: " + record_type)
        except (OSError, subprocess.TimeoutExpired):
            require(False, "public hostname observation unavailable: " + record_type)
receipt["errors"] = errors
if not errors:
    receipt["status"] = "success"
with open(receipt_path, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2)
if errors:
    raise SystemExit("k3s DNS prepublication refused: " + "; ".join(errors))
print("Current TEST DNS writer/substrate/zone verified before overlay publication")
