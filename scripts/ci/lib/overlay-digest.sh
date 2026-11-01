#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/overlay-digest.sh — sourceable helper for reading a
# kustomize overlay's *-app image reference (digest pin if present, else
# tag pin).
#
# Function: extract_overlay_image_ref ENV APP
#   - ENV  e.g. "preview", "candidate-a"
#   - APP  e.g. "operator", "poly", "resy", "scheduler-worker"
#   - cwd must be the repo root (or any tree where
#     `infra/k8s/overlays/<ENV>/<APP>/kustomization.yaml` resolves).
#   - prints one of:
#       - "ghcr.io/cogni-dao/cogni-template@sha256:<hex>"  (digest pin)
#       - "ghcr.io/cogni-dao/cogni-template:<tag>"         (tag pin only)
#   - returns 0 on success; non-zero with stderr message if the file is
#     missing or no app image block / digest / tag is found.
#
# Sourced by candidate-flight.yml's per-node substrate-shape preservation.

extract_overlay_image_ref() {
  local env="$1" app="$2"
  local file="infra/k8s/overlays/${env}/${app}/kustomization.yaml"
  if [ ! -f "$file" ]; then
    echo "[ERROR] missing $file" >&2
    return 1
  fi
  python3 - "$file" <<'PY'
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
blocks = re.split(r"\n[ \t]*-\s+name:\s*", "\n" + text)
for block in blocks[1:]:
    line = block.split("\n", 1)[0].strip()
    if line != "ghcr.io/cogni-dao/cogni-template":
        continue
    rest = block.split("\n", 1)[1] if "\n" in block else ""
    m = re.search(r'^\s*digest:\s*"(sha256:[0-9a-f]+)"', rest, re.MULTILINE)
    if m:
        print(f"{line}@{m.group(1)}", end="")
        sys.exit(0)
    m = re.search(r"^\s*newTag:\s*(\S+)", rest, re.MULTILINE)
    if m:
        print(f"{line}:{m.group(1).strip()}", end="")
        sys.exit(0)
    print(f"[ERROR] no digest/newTag under {line} in {path}", file=sys.stderr)
    sys.exit(1)
print(f"[ERROR] no app image block in {path}", file=sys.stderr)
sys.exit(1)
PY
}

# Keep image-owned init entrypoints paired with the old digest during the
# preliminary substrate-shape commit. The final overlay rsync removes this
# compatibility patch before promoting the new image and its own entrypoints.
snapshot_overlay_init_contract() {
  local env="$1" app="$2" image="$3" snapshot="$4"
  local overlay="infra/k8s/overlays/${env}/${app}" rendered
  rendered="$(mktemp)"
  if ! kubectl kustomize "$overlay" | yq eval-all -o=json -I=0 '[.]' - > "$rendered"; then
    rm -f "$rendered"
    return 1
  fi
  python3 - "$rendered" "$snapshot" "$app" "$image" "$(git rev-parse HEAD)" <<'PYTHON'
import json
import sys

rendered, output, app, image, head = sys.argv[1:]
docs = json.load(open(rendered, encoding="utf-8"))
targets = [d for d in docs if d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") in (f"{app}-node-app", app)]
if len(targets) != 1:
    raise SystemExit("init compatibility: expected one named node Deployment")
spec = targets[0]["spec"]["template"]["spec"]
containers = spec.get("initContainers", [])
if not isinstance(containers, list):
    raise SystemExit("init compatibility: invalid init containers")
contract = []
seen = set()
for container in containers:
    name = container.get("name")
    if not isinstance(name, str) or not name or name in seen or container.get("image") != image:
        raise SystemExit("init compatibility: ambiguous name or unmatched init image")
    seen.add(name)
    entry = {"name": name}
    for field in ("command", "args"):
        if field in container:
            value = container[field]
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise SystemExit("init compatibility: invalid entrypoint")
            entry[field] = value
    contract.append(entry)
with open(output, "w", encoding="utf-8") as handle:
    json.dump({"head": head, "image": image, "deployment": targets[0]["metadata"]["name"], "initContainers": contract}, handle)
PYTHON
  local result=$?
  rm -f "$rendered"
  return "$result"
}

restore_overlay_init_contract() {
  local env="$1" app="$2" image="$3" snapshot="$4"
  local overlay="infra/k8s/overlays/${env}/${app}" rendered patch
  rendered="$(mktemp)"
  patch="$overlay/.prepare-init-compatibility.json"
  if ! kubectl kustomize "$overlay" | yq eval-all -o=json -I=0 '[.]' - > "$rendered"; then
    rm -f "$rendered"
    return 1
  fi
  if ! python3 - "$rendered" "$snapshot" "$patch" "$app" "$image" "$(git rev-parse HEAD)" <<'PYTHON'
import json
import sys

rendered, snapshot, output, app, image, head = sys.argv[1:]
contract = json.load(open(snapshot, encoding="utf-8"))
if contract["head"] != head or contract["image"] != image or contract["deployment"] not in (f"{app}-node-app", app):
    raise SystemExit("init compatibility: changed deploy HEAD or image binding")
docs = json.load(open(rendered, encoding="utf-8"))
targets = [d for d in docs if d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == contract["deployment"]]
if len(targets) != 1:
    raise SystemExit("init compatibility: expected one named node Deployment")
containers = targets[0]["spec"]["template"]["spec"].get("initContainers", [])
old = {c["name"]: c for c in contract["initContainers"]}
names = [c.get("name") for c in containers]
if len(names) != len(set(names)) or set(names) != set(old):
    raise SystemExit("init compatibility: changed or ambiguous init names")
operations = []
for index, container in enumerate(containers):
    if container.get("image") != image:
        raise SystemExit("init compatibility: unmatched preserved init image")
    prior = old[container["name"]]
    for field in ("command", "args"):
        path = f"/spec/template/spec/initContainers/{index}/{field}"
        if field in prior:
            operations.append({"op": "add", "path": path, "value": prior[field]})
        elif field in container:
            operations.append({"op": "remove", "path": path})
with open(output, "w", encoding="utf-8") as handle:
    json.dump(operations, handle)
PYTHON
  then
    rm -f "$rendered"
    return 1
  fi
  rm -f "$rendered"
  # Services with no init containers have no image-owned entrypoints to patch.
  if [ "$(cat "$patch")" = "[]" ]; then
    rm -f "$patch"
    return 0
  fi
  # Append last: source overlay patches must not override the old-image contract.
  yq -i \
    '.patches += [{"target": {"kind": "Deployment", "name": "node-app"}, "path": ".prepare-init-compatibility.json"}]' \
    "$overlay/kustomization.yaml"
  # Kustomize target matching must not silently accept an unapplied patch.
  local applied result
  applied="$(mktemp)"
  if ! snapshot_overlay_init_contract "$env" "$app" "$image" "$applied"; then
    rm -f "$applied"
    return 1
  fi
  python3 - "$snapshot" "$applied" <<'PYTHON'
import json
import sys

before, after = [json.load(open(p, encoding="utf-8")) for p in sys.argv[1:]]
for value in (before, after):
    value["initContainers"].sort(key=lambda c: c["name"])
if before != after:
    raise SystemExit("init compatibility: rendered entrypoint contract differs")
PYTHON
  result=$?
  rm -f "$applied"
  return "$result"
}

# Read one established k3s acceptance from a destination tree. Unlike the
# historical shape helper above, this seam admits only a complete immutable
# digest and source, with unique mapping and matching repository authority.
read_accepted_app() {
  local env="$1" app="$2" image_repository="$3" source_repository="$4"
  local file="infra/k8s/overlays/${env}/${app}/kustomization.yaml"
  [[ -f "$file" && -f ".promote-state/source-sha-by-app.json" && -f "infra/catalog/$app.yaml" ]] || {
    echo 'accepted_app_missing' >&2; return 1;
  }
  local images repo
  images=$(yq -o=json '.images' "$file") || return 1
  repo=$(yq -r '.source_repo // ""' "infra/catalog/$app.yaml") || return 1
  repo="${repo:-${GITHUB_REPOSITORY:-cogni-dao/cogni}}"
  [[ "$repo" = "$source_repository" ]] || { echo 'accepted_repository_mismatch' >&2; return 1; }
  python3 - "$images" "$app" "$image_repository" <<'PY'
import json, re, sys
def unique(pairs):
    out = {}
    for k,v in pairs:
        if k in out:
            raise ValueError('duplicate acceptance field')
        out[k] = v
    return out
images, app, repository = sys.argv[1:]
values = json.loads(images, object_pairs_hook=unique)
if not isinstance(values, list):
    raise SystemExit('accepted_images_invalid')
# Kustomize's logical app name is fixed; newName is the physical repository.
matching = [x for x in values if x.get('name') == 'ghcr.io/cogni-dao/cogni-template']
if len(matching) != 1:
    raise SystemExit('accepted_image_ambiguous')
value = matching[0]
if value.get('newName', value['name']) != repository or not re.fullmatch(r'sha256:[a-f0-9]{64}', value.get('digest', '')) or value.get('newTag'):
    raise SystemExit('accepted_image_invalid')
source = json.load(open('.promote-state/source-sha-by-app.json'), object_pairs_hook=unique).get(app)
if not isinstance(source, str) or not re.fullmatch('[a-f0-9]{40}', source):
    raise SystemExit('accepted_source_invalid')
print(json.dumps({'source_sha': source, 'digest': repository + '@' + value['digest']}))
PY
}

# Full infra intent is never authority to advance an app. This check also
# fences external-bundle materialization without changing that bundle owner.
assert_infra_source_current() {
  local requested="$1" app="$2"
  python3 - "$requested" "$app" <<'PY'
import json, re, sys
requested, app = sys.argv[1:]
def unique(pairs):
    result = {}
    for k,v in pairs:
        if k in result: raise ValueError('duplicate accepted source')
        result[k] = v
    return result
source = json.load(open('.promote-state/source-sha-by-app.json'), object_pairs_hook=unique).get(app)
if not isinstance(source, str) or not re.fullmatch('[a-f0-9]{40}', source):
    raise SystemExit('accepted_source_invalid')
if source != requested:
    raise SystemExit('stale_infra_source')
PY
}

# Branch existence is not acceptance: provision 4b.5 seeds source HEAD and
# 4c mirrors one env-state commit, including preview digests, to every node.
# Prove that history against a native source ref. Missing/truncated history or
# any old target acceptance cannot become initial state after file damage.
destination_app_is_established() {
  python3 - "$1" "$2" <<'PYTHON'
import json, pathlib, re, subprocess, sys
env, app = sys.argv[1:]
def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE, timeout=30).decode()
def unique(pairs):
    out = {}
    for k,v in pairs:
        if k in out: raise ValueError('duplicate acceptance field')
        out[k] = v
    return out
def blob(rev, path):
    # ls-tree distinguishes absence from a failed or incomplete object read.
    row = git('ls-tree', rev, '--', path).strip()
    if not row: return None
    if not row.startswith('100644 blob '): raise ValueError('seed_file_invalid')
    return git('show', rev + ':' + path)
def accepted(rev):
    value = blob(rev, '.promote-state/source-sha-by-app.json')
    if value is None: return False
    value = json.loads(value, object_pairs_hook=unique)
    if not isinstance(value, dict): raise ValueError('accepted_map_invalid')
    return app in value
try:
    if git('rev-parse', '--is-shallow-repository').strip() != 'false':
        raise ValueError('seed_history_incomplete')
    revisions = git('rev-list', '--first-parent', '--max-count=257', 'HEAD').splitlines()
    seed = None
    for index, rev in enumerate(revisions):
        if accepted(rev):
            print('true'); raise SystemExit(0)
        refs = git('for-each-ref', '--contains=' + rev, '--format=%(refname)', 'refs/remotes/origin/').splitlines()
        if any(x != 'refs/remotes/origin/HEAD' and not x.startswith('refs/remotes/origin/deploy/') for x in refs):
            # A source ref name cannot erase acceptance history. Code branches
            # never write deploy state, even when provisioning from a PR HEAD.
            source_changes = git('rev-list', '--max-count=1', rev, '^origin/main', '--', '.promote-state').strip()
            if not source_changes:
                seed = rev; break
    if seed is None: raise ValueError('seed_history_unproven')
    # Check EACH commit, not just final shape: accepting then damaging/removing
    # the map or reversing a non-provision mutation never erases that history.
    for rev in revisions[:index]:
        parents = git('show', '-s', '--format=%P', rev).split()
        if len(parents) != 1: raise ValueError('seed_history_ambiguous')
        paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', parents[0], rev).splitlines()
        for path in paths:
            # Umbrella history includes other nodes. Their acceptance and
            # configuration cannot establish THIS node's release. Every map
            # revision was parsed above and contains no acceptance for app.
            if path == '.promote-state/source-sha-by-app.json':
                continue
            if not path.startswith('infra/k8s/overlays/' + env + '/' + app + '/'):
                continue
            if re.fullmatch(r'infra/k8s/overlays/' + re.escape(env) + r'/[^/]+/env-state.yaml', path):
                value = blob(rev, path)
                data = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=value.encode(), timeout=20))
                if (data.get('kind') != 'ConfigMap' or data.get('metadata', {}).get('name') != 'env-state'
                        or set(data.get('data', {})) != {'VM_IP'}):
                    raise ValueError('seed_env_state_invalid')
                continue
            m = re.fullmatch(r'infra/k8s/overlays/(' + re.escape(env) + r'|_template)/([^/]+)/kustomization.yaml', path)
            if not m: raise ValueError('seed_mutation_unproven')
            before, after = blob(parents[0], path), blob(rev, path)
            if before is None and after == blob('origin/main', path):
                # Existing umbrella receives a newly declared node's exact
                # source-owned shape before its first release.
                continue
            if before is None or after is None: raise ValueError('seed_overlay_missing')
            catalog = blob(seed, 'infra/catalog/' + m[2] + '.yaml')
            if catalog is None: raise ValueError('seed_catalog_missing')
            declaration = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=catalog.encode(), timeout=20))
            boot = declaration.get('bootstrap_image_tag')
            if boot:
                before = before.replace('newTag: "' + env + '-placeholder-' + m[2] + '"', 'newTag: "' + boot + '"')
                suffix, migrator = declaration.get('image_tag_suffix'), declaration.get('migrator_tag_suffix')
                if suffix and migrator:
                    before = before.replace('newTag: "' + env + '-placeholder' + migrator + '"',
                                            'newTag: "' + boot.removesuffix(suffix) + migrator + '"')
            preview = blob(seed, 'infra/k8s/overlays/preview/' + m[2] + '/kustomization.yaml')
            if preview and m[1] == env:
                value = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=preview.encode(), timeout=20))
                digest = (value.get('images') or [{}])[0].get('digest')
                if digest and digest != 'sha256:' + '0'*64:
                    before = re.sub(r'(^[ \t]*digest:[ \t]*").*(")', lambda x: x[1] + digest + x[2], before, flags=re.M)
            # Provision substitutes only the existing vm.cognidao.org endpoint.
            host = re.search(r'([a-z0-9-]+\.)*vm\.[a-z0-9.-]+', after)
            if host:
                before = re.sub(r'([a-z0-9-]+\.)*vm\.cognidao\.org', lambda _: host[0], before)
            if before != after: raise ValueError('seed_overlay_unproven')
    print('false')
except Exception as error:
    print('destination_seed_unproven: ' + str(error), file=sys.stderr)
    raise SystemExit(1)
PYTHON
}
