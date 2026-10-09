// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/openfga-model-canonicalization`
 * Purpose: Prove the OpenFGA bootstrap's model hash is round-trip stable, so a store already holding the git model is recognized instead of having another copy appended on every deploy.
 * Scope: Exercises `canonical_model_json` and `model_hash` extracted from the real bootstrap script against the git model and a reconstruction of how OpenFGA serializes it back; does not reach an OpenFGA server, the network, or a VM.
 * Invariants:
 *   - ROUND_TRIP_STABLE: canonical(git model) and canonical(that model as OpenFGA
 *     returns it) hash identically.
 *   - WRITE_BODY_UNCHANGED: the git-side canonical form is still the authored model, so
 *     the fix writes no new model by itself.
 *   - EMPTY_OBJECTS_ARE_LOAD_BEARING: `"this": {}` inside `type_definitions` survives.
 * Side-effects: IO (spawns bash; reads infra/openfga/rbac-model.json)
 * Links: bug.5417, scripts/ci/AGENTS.md
 * @public
 *
 * WHY THIS EXISTS. OpenFGA serializes an authorization model with its protobuf defaults
 * populated, so reading back the very model the bootstrap just wrote returns keys that
 * were never in git. The canonicalizer dropped nulls only, so those defaults survived
 * into the hash and the comparison could never succeed. Every production infra deploy
 * since #2103 logged `configured authorization model hash differs from git model`
 * against an untouched model file and appended another semantically identical model;
 * candidate-a's store was measured at 31 of them. A hash that is never a hit is worse
 * than no hash, because it hides real drift behind a permanent false positive.
 *
 * The defaults in DEPLOYED_DEFAULTS are not guessed. They are the ones the live
 * candidate-a store returned, read off the canonical diff this fix also added:
 * `module: ""`, `condition: ""`, `object: ""`, `relations: {}`, `conditions: {}`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BOOTSTRAP = path.join(REPO_ROOT, "scripts/ci/bootstrap-openfga.sh");
const MODEL = path.join(REPO_ROOT, "infra/openfga/rbac-model.json");

type Json = Record<string, unknown>;

/**
 * Runs `body` with the real script's `canonical_model_json` and `model_hash` in scope,
 * piping `stdin` in. The functions are extracted rather than reimplemented — a copy of
 * the jq program here would keep passing while the shipped one drifted.
 */
function runWithBootstrapFns(body: string, stdin: string): string {
  const file = JSON.stringify(BOOTSTRAP);
  const script = [
    "set -uo pipefail",
    'die() { printf "%s\\n" "$*" >&2; exit 1; }',
    `eval "$(sed -n '/^model_hash() {/,/^}/p' ${file})"`,
    `eval "$(sed -n '/^canonical_model_json() {/,/^}/p' ${file})"`,
    body,
  ].join("\n");

  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    input: stdin,
  }).trim();
}

const canonicalOf = (model: string): string =>
  runWithBootstrapFns("canonical_model_json", model);
const hashOf = (model: string): string =>
  runWithBootstrapFns("canonical_model_json | model_hash", model);

const AUTHORED = readFileSync(MODEL, "utf8");

/**
 * Reconstructs what `GET /stores/{id}/authorization-models/{id}` returns for a model
 * written from `AUTHORED`: wrapped in `authorization_model`, carrying a server-assigned
 * `id`, and with every protobuf default populated.
 */
function asOpenFgaReturnsIt(authored: string): string {
  const model = JSON.parse(authored) as {
    type_definitions: Json[];
    [k: string]: unknown;
  };

  // `condition: ""` on every userset; `object: ""` on computedUserset.
  const addUsersetDefaults = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) addUsersetDefaults(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Json;
    if ("this" in obj || "computedUserset" in obj || "tupleToUserset" in obj) {
      obj.condition ??= "";
    }
    const computed = obj.computedUserset;
    if (computed && typeof computed === "object") {
      (computed as Json).object ??= "";
    }
    for (const child of Object.values(obj)) addUsersetDefaults(child);
  };

  for (const typeDef of model.type_definitions) {
    // A type declaring no relations comes back with an empty map, not an absent key.
    typeDef.relations ??= {};
    typeDef.metadata ??= {};
    const metadata = typeDef.metadata as Json;
    metadata.module ??= "";
    metadata.relations ??= {};
    for (const relation of Object.values(metadata.relations as Json)) {
      if (relation && typeof relation === "object") {
        (relation as Json).module ??= "";
      }
    }
    addUsersetDefaults(typeDef.relations);
  }

  return JSON.stringify({
    authorization_model: { id: "01ABCDEF", ...model, conditions: {} },
  });
}

const DEPLOYED = asOpenFgaReturnsIt(AUTHORED);

describe("openfga authorization model canonicalization (bug.5417)", () => {
  it("the reconstruction actually carries the defaults it claims to", () => {
    // Guards against a vacuous round-trip test: if this reconstruction stopped
    // injecting defaults, ROUND_TRIP_STABLE below would pass for the wrong reason.
    const occurrences = (needle: string) => DEPLOYED.split(needle).length - 1;

    expect(occurrences('"module":""')).toBeGreaterThan(0);
    expect(occurrences('"condition":""')).toBeGreaterThan(0);
    expect(occurrences('"object":""')).toBeGreaterThan(0);
    expect(occurrences('"relations":{}')).toBeGreaterThan(0);
    expect(occurrences('"conditions":{}')).toBe(1);
  });

  it("ROUND_TRIP_STABLE: a model read back from OpenFGA hashes the same as the git model", () => {
    const gitHash = hashOf(AUTHORED);

    expect(gitHash).toMatch(/^[0-9a-f]{64}$/);
    // The whole point: equal, so bootstrap recognizes its own model instead of
    // appending another one on every deploy.
    expect(hashOf(DEPLOYED)).toBe(gitHash);
  });

  it("WRITE_BODY_UNCHANGED: the git-side canonical form is still the model as authored", () => {
    // This projection is the POST body, so a change here writes a NEW authorization
    // model to every environment on the next deploy. That must only ever follow a
    // deliberate model change, never a canonicalizer tweak. Asserted structurally
    // rather than as a pinned digest, so a jq formatting change cannot fail it
    // spuriously — the claim is about content, not bytes.
    const canonical = JSON.parse(canonicalOf(AUTHORED)) as Json;
    const authored = JSON.parse(AUTHORED) as Json;

    expect(Object.keys(canonical).sort()).toStrictEqual([
      "schema_version",
      "type_definitions",
    ]);
    expect(canonical.schema_version).toStrictEqual(authored.schema_version);
    expect(canonical.type_definitions).toStrictEqual(authored.type_definitions);
  });

  it("EMPTY_OBJECTS_ARE_LOAD_BEARING: `this: {}` survives while empty protobuf maps do not", () => {
    const gitCanonical = canonicalOf(AUTHORED);
    const deployedCanonical = canonicalOf(DEPLOYED);
    const thisMarkers = (canonical: string) =>
      canonical.split('"this": {}').length - 1;

    // `"this": {}` is OpenFGA's direct-relation marker. Dropping it would silently
    // rewrite the authorization model, since this projection is also the POST body.
    expect(thisMarkers(gitCanonical)).toBeGreaterThan(0);
    expect(thisMarkers(deployedCanonical)).toBe(thisMarkers(gitCanonical));

    // Empty protobuf map fields are normalized away on BOTH sides, which is what makes
    // the two comparable at all.
    for (const canonical of [gitCanonical, deployedCanonical]) {
      expect(canonical).not.toContain('"conditions"');
      expect(canonical).not.toContain('"relations": {}');
      expect(canonical).not.toContain('""');
    }
  });
});
