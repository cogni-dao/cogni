// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/tests/k3s-dns`
 * Purpose: Verify catalog DNS ownership, the actual generated jq guards and fixture projection.
 * Scope: Pure data, jq and owned temporary files. Does not contact providers or deployed services.
 * Invariants: Absent intent is inert; foreign/ambiguous observations cannot reach update/delete.
 * Side-effects: IO (owned temporary files and child jq, generator and Kustomize processes).
 * Links: bug.5526, isolated-k3s-workload-dns
 * @internal
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import overlayModule from "../../../nodes/operator/app/src/shared/node-app-scaffold/gens/overlay.ts";

const { renderOverlay } = overlayModule;

import { test } from "node:test";
import dnsModule from "../../../nodes/operator/app/src/shared/node-app-scaffold/gens/k3s-dns.ts";

const {
  buildK3sDnsRequest,
  k3sWorkloadDomain,
  projectK3sDnsOverlay,
  stripK3sDnsProjection,
} = dnsModule;

const nodeId = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const catalog = {
  name: "node-template",
  type: "node",
  envs: ["candidate-a"],
  deployment_provider: { "candidate-a": "k3s" },
  k3s_dns: {
    "candidate-a": {
      mode: "crossplane-http",
      workloadDomain: "cogni-testing.org",
      zoneId: "a".repeat(32),
      target: "cogni-candidate-a.vm.cognidao.org",
    },
  },
};
const input = {
  catalog,
  environment: "candidate-a",
  repository: "cogni-test-org/cogni-monorepo",
  nodeId,
  controlDomain: "test.cognidao.org",
  workloadDomain: "cogni-testing.org",
  substrateRoot: "cognidao.org",
};
const jq = (filter, context) =>
  JSON.parse(
    execFileSync(process.env.K3S_DNS_JQ_BIN ?? "jq", ["-c", filter], {
      input: JSON.stringify(context),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
  );
test("split hostname agrees with existing k3s suffix, canonical and primary domains", () => {
  assert.equal(
    k3sWorkloadDomain("test.cognidao.org", "cogni-testing.org", "cognidao.org"),
    "test.cogni-testing.org"
  );
  assert.equal(
    k3sWorkloadDomain("test.cognidao.org", "test.cognidao.org", "cognidao.org"),
    "test.cognidao.org"
  );
  assert.throws(() =>
    k3sWorkloadDomain(
      "test.cognidao.org.evil.org",
      "cogni-testing.org",
      "cognidao.org"
    )
  );
});
test("catalog opt-in emits one DNS-only namespaced resource with reference-only auth", () => {
  assert.equal(
    buildK3sDnsRequest({
      ...input,
      catalog: { ...catalog, k3s_dns: undefined },
    }),
    null
  );
  const r = buildK3sDnsRequest(input);
  assert.equal(r.apiVersion, "http.m.crossplane.io/v1alpha2");
  assert.equal(r.kind, "Request");
  assert.equal(r.metadata.namespace, "cogni-candidate-a");
  assert.deepEqual(r.spec.providerConfigRef, {
    kind: "ClusterProviderConfig",
    name: "cogni-http",
  });
  assert.deepEqual(r.spec.forProvider.headers.Authorization, [
    "Bearer {{ operator-env-secrets:cogni-candidate-a:CLOUDFLARE_API_TOKEN }}",
  ]);
  const b = JSON.parse(r.spec.forProvider.payload.body);
  assert.equal(b.name, "node-template-test.cogni-testing.org");
  assert.equal(b.type, "CNAME");
  assert.equal(b.content, catalog.k3s_dns["candidate-a"].target);
  assert.equal(b.proxied, true);
  assert.ok(b.comment.includes(nodeId));
  assert.ok(b.comment.includes("cogni-test-org/cogni-monorepo"));
  for (const patch of [
    { is_primary_host: true },
    { name: "www" },
    { envs: ["production"] },
    { deployment_provider: { "candidate-a": "akash" } },
    {
      k3s_dns: {
        "candidate-a": { ...catalog.k3s_dns["candidate-a"], mode: "unknown" },
      },
    },
    {
      k3s_dns: {
        "candidate-a": {
          ...catalog.k3s_dns["candidate-a"],
          target: "https://evil/",
        },
      },
    },
    {
      k3s_dns: {
        "candidate-a": { ...catalog.k3s_dns["candidate-a"], zoneId: "secret" },
      },
    },
    {
      k3s_dns: {
        "candidate-a": { ...catalog.k3s_dns["candidate-a"], extra: "x" },
      },
    },
  ])
    assert.throws(() =>
      buildK3sDnsRequest({ ...input, catalog: { ...catalog, ...patch } })
    );
});
test("live Observe owner/cardinality errors fence cached valid identity; fixed CREATE needs no stale response", () => {
  const r = buildK3sDnsRequest(input).spec.forProvider;
  const body = JSON.parse(r.payload.body);
  const owned = {
    id: "b".repeat(32),
    name: body.name,
    type: "CNAME",
    content: body.content,
    proxied: true,
    comment: body.comment,
  };
  const ctx = (result) => ({
    payload: { ...r.payload, body },
    response: {
      statusCode: 200,
      body: {
        success: true,
        result,
        result_info: { total_count: result.length },
      },
    },
  });
  assert.equal(jq(r.isRemovedCheck.logic, ctx([])), true);
  assert.equal(jq(r.isRemovedCheck.logic, ctx([owned])), false);
  const update = r.mappings.find((x) => x.action === "UPDATE").url;
  const remove = r.mappings.find((x) => x.action === "REMOVE").url;
  assert.equal(jq(update, ctx([owned])), `${r.payload.baseUrl}/${owned.id}`);
  assert.equal(jq(remove, ctx([owned])), `${r.payload.baseUrl}/${owned.id}`);
  for (const records of [
    [owned, owned],
    [{ ...owned, type: "TXT" }],
    [{ ...owned, type: "MX" }],
    [{ ...owned, comment: "foreign" }],
    [owned, { ...owned, type: "AAAA" }],
  ]) {
    // Actual fresh Observe guard errors BEFORE provider may fall back to cached update context.
    assert.throws(() => jq(r.isRemovedCheck.logic, ctx(records)));
    assert.throws(() => jq(update, ctx(records)));
  }
  assert.equal(jq(r.expectedResponseCheck.logic, ctx([owned])), true);
  assert.equal(
    jq(
      r.expectedResponseCheck.logic,
      ctx([{ ...owned, content: "drift.example" }])
    ),
    false
  );
  for (const response of [
    { statusCode: 503, body: {} },
    { statusCode: 200, body: { success: true, result: "bad" } },
  ])
    assert.throws(() => jq(r.isRemovedCheck.logic, { ...ctx([]), response }));
  const create = r.mappings.find((x) => x.action === "CREATE");
  assert.equal(
    jq(create.url, { payload: { ...r.payload, body }, response: {} }),
    r.payload.baseUrl
  );
  assert.deepEqual(
    jq(create.body, { payload: { ...r.payload, body }, response: {} }),
    body
  );
});

test("generated template DNS never clones; real CLI projection is deterministic and Kustomize accepts it", () => {
  const root = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "k3s-dns-"));
  const copy = (file) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(dir, file), { recursive: true });
  };
  try {
    for (const file of [
      "scripts/lib/render-k3s-dns.mjs",
      "scripts/ci/render-node-overlays.sh",
      "nodes/operator/app/src/shared/node-app-scaffold/gens/k3s-dns.ts",
      "infra/k8s/base/node-app",
      "infra/k8s/overlays/candidate-a/node-template",
    ])
      copy(file);
    mkdirSync(path.join(dir, "infra/catalog"), { recursive: true });
    const full = JSON.parse(
      execFileSync("yq", ["-o=json", ".", "infra/catalog/node-template.yaml"], {
        encoding: "utf8",
      })
    );
    Object.assign(full, structuredClone(catalog), { node_id: nodeId });
    const cat = path.join(dir, "infra/catalog/node-template.yaml");
    writeFileSync(cat, JSON.stringify(full));
    const clone = {
      ...full,
      name: "clone",
      node_port: 30299,
      port: 3299,
      k3s_dns: undefined,
    };
    writeFileSync(
      path.join(dir, "infra/catalog/clone.yaml"),
      JSON.stringify(clone)
    );
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: input.repository,
      CONTROL_DOMAIN: input.controlDomain,
      FORK_DOMAIN_ROOT: input.substrateRoot,
    };
    const cli = (mode) =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(dir, "scripts/lib/render-k3s-dns.mjs"),
          mode,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
    cli("--write");
    cli("--check");
    const overlay = path.join(
      dir,
      "infra/k8s/overlays/candidate-a/node-template/kustomization.yaml"
    );
    const generated = readFileSync(overlay, "utf8");
    cli("--write");
    assert.equal(readFileSync(overlay, "utf8"), generated);
    assert.equal(
      projectK3sDnsOverlay(generated, "node-template-test.cogni-testing.org"),
      generated
    );
    const stripped = stripK3sDnsProjection(generated);
    assert.ok(!stripped.includes("k3s-dns-request.json"));
    const shell = execFileSync(
      "bash",
      [
        path.join(dir, "scripts/ci/render-node-overlays.sh"),
        "candidate-a",
        "clone",
      ],
      { env: { ...env, DOMAIN: "cognidao.org" }, encoding: "utf8" }
    );
    assert.equal(shell, renderOverlay(generated, "clone", 30299, 3299));
    assert.ok(!shell.includes("cogni-testing.org"));
    const built = execFileSync(
      "kubectl",
      ["kustomize", path.dirname(overlay)],
      { encoding: "utf8" }
    );
    assert.match(built, /kind: Request/);
    assert.match(built, /name: node-template-workload-dns/);
    assert.match(
      built,
      /NEXTAUTH_URL: https:\/\/node-template-test\.cogni-testing\.org/
    );
    rmSync(path.join(dir, "infra/catalog/clone.yaml"));
    const summary = path.join(dir, "legacy-summary.json");
    execFileSync("bash", ["scripts/ci/reconcile-node-dns.sh", "candidate-a"], {
      env: {
        ...env,
        COGNI_CATALOG_ROOT: path.join(dir, "infra/catalog"),
        DOMAIN: "cogni-testing.org",
        DNS_RECONCILE_SUMMARY_FILE: summary,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ZONE_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const delegated = JSON.parse(readFileSync(summary, "utf8"));
    assert.equal(delegated.status, "success");
    assert.ok(
      delegated.records.some(
        (x) => x.node === "node-template" && x.state === "delegated"
      )
    );
    full.k3s_dns["candidate-a"].mode = "unknown";
    writeFileSync(cat, JSON.stringify(full));
    assert.throws(() =>
      execFileSync(
        "bash",
        ["scripts/ci/reconcile-node-dns.sh", "candidate-a"],
        {
          env: {
            ...env,
            COGNI_CATALOG_ROOT: path.join(dir, "infra/catalog"),
            DOMAIN: "cogni-testing.org",
            DNS_RECONCILE_SUMMARY_FILE: summary,
            CLOUDFLARE_API_TOKEN: "",
            CLOUDFLARE_ZONE_ID: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
    );
    full.k3s_dns = undefined;
    writeFileSync(cat, JSON.stringify(full));
    assert.throws(() => cli("--check"));
    cli("--write");
    assert.ok(
      !existsSync(path.join(path.dirname(overlay), "k3s-dns-request.json"))
    );
    assert.equal(readFileSync(overlay, "utf8"), stripped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("runtime domain disagreement fails before publication and zero-zone receipt cannot pass", () => {
  assert.throws(
    () => buildK3sDnsRequest({ ...input, workloadDomain: "test.cognidao.org" }),
    /dns_workload_domain_mismatch/
  );
  const workflow = readFileSync(
    ".github/workflows/candidate-flight.yml",
    "utf8"
  );
  assert.ok(
    workflow.indexOf("Assert isolated DNS before overlay publication") <
      workflow.indexOf("- name: Prepare deploy branch shape")
  );
  const dir = mkdtempSync(path.join(tmpdir(), "k3s-dns-guard-"));
  try {
    const receipt = {
      node: "node-template",
      environment: "candidate-a",
      repository: input.repository,
      zoneId: "0".repeat(32),
      configuredZoneId: "a".repeat(32),
    };
    const facts = {
      crd: {},
      provider: {},
      config: {},
      eso: {},
      appset: {},
      app: {},
      deployment: {},
      service: {},
      endpoints: [],
    };
    writeFileSync(path.join(dir, "receipt"), JSON.stringify(receipt));
    writeFileSync(path.join(dir, "facts"), JSON.stringify(facts));
    assert.throws(() =>
      execFileSync(
        "python3",
        [
          "scripts/ci/lib/check-k3s-dns-preflight.py",
          path.join(dir, "receipt"),
          path.join(dir, "facts"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      )
    );
    const result = JSON.parse(readFileSync(path.join(dir, "receipt"), "utf8"));
    assert.equal(result.status, "failure");
    assert.ok(result.errors.includes("configured TEST zone disagreement"));
    const conditions = (...types) =>
      types.map((type) => ({ type, status: "True" }));
    const positive = {
      ...receipt,
      zoneId: "a".repeat(32),
      host: "node-template-test.cogni-testing.org",
      owner: "fixture-owner",
    };
    const known = {
      ...facts,
      crd: { conditions: conditions("Established") },
      provider: {
        conditions: conditions("Installed", "Healthy"),
        package:
          "xpkg.upbound.io/crossplane-contrib/provider-http:v1.0.15@sha256:53ff679013f4787fcb00c7d36fd4520340543f9ebd35bef581eed42c37d7c5b6",
      },
      config: { source: "None" },
      eso: { conditions: conditions("Ready") },
      keyPresent: true,
      appset: {
        name: "cogni-candidate-a-node-template",
        uid: "test-appset-uid",
        generators: [
          {
            git: {
              repoURL: "https://github.com/cogni-test-org/cogni-monorepo.git",
              revision: "deploy/candidate-a-node-template",
            },
          },
        ],
        source: {
          repoURL: "https://github.com/cogni-test-org/cogni-monorepo.git",
          targetRevision: "deploy/candidate-a-{{.name}}",
        },
      },
      dnsRequest: { owner: "fixture-owner" },
    };
    const run = (r, f) => {
      writeFileSync(path.join(dir, "receipt"), JSON.stringify(r));
      writeFileSync(path.join(dir, "facts"), JSON.stringify(f));
      let passed = true;
      try {
        execFileSync(
          "python3",
          [
            "scripts/ci/lib/check-k3s-dns-preflight.py",
            path.join(dir, "receipt"),
            path.join(dir, "facts"),
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch {
        passed = false;
      }
      return {
        passed,
        receipt: JSON.parse(readFileSync(path.join(dir, "receipt"), "utf8")),
      };
    };
    const bootstrap = run(positive, known);
    assert.equal(bootstrap.passed, true);
    assert.equal(bootstrap.receipt.workloadReadiness.availableReplicas, 0);
    assert.equal(
      run(positive, { ...known, app: { readError: true } }).passed,
      false
    );
    assert.equal(
      run(positive, {
        ...known,
        app: {
          name: "candidate-a-node-template",
          source: { repoURL: "https://github.com/cogni-dao/cogni.git" },
        },
      }).passed,
      false
    );
    assert.equal(
      run(positive, {
        ...known,
        appset: {
          ...known.appset,
          generators: [
            {
              git: {
                repoURL: "https://github.com/cogni-dao/cogni.git",
                revision: "main",
              },
            },
          ],
        },
      }).passed,
      false
    );
    assert.equal(
      run({ ...positive, zoneId: "0".repeat(32) }, known).passed,
      false
    );
    assert.equal(
      run(positive, { ...known, dnsRequest: { owner: "foreign" } }).passed,
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
