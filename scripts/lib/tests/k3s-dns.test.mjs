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
import { createHash } from "node:crypto";
import {
  chmodSync,
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
    delete full.compute_api;
    full.activity_env = "candidate-a";
    const cat = path.join(dir, "infra/catalog/node-template.yaml");
    writeFileSync(cat, JSON.stringify(full));
    execFileSync(
      "check-jsonschema",
      ["--schemafile", "infra/catalog/_schema.json", cat],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    for (const patch of [{ mode: "unknown" }, { extra: "unreviewed" }]) {
      const invalid = structuredClone(full);
      Object.assign(invalid.k3s_dns["candidate-a"], patch);
      const invalidPath = path.join(dir, "invalid-catalog.json");
      writeFileSync(invalidPath, JSON.stringify(invalid));
      assert.throws(() =>
        execFileSync(
          "check-jsonschema",
          ["--schemafile", "infra/catalog/_schema.json", invalidPath],
          { stdio: ["ignore", "pipe", "pipe"] }
        )
      );
    }
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
    const requestPath = path.join(
      dir,
      "infra/k8s/overlays/candidate-a/node-template/k3s-dns-request.json"
    );
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    cli("--check");
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(dir, "scripts/lib/render-k3s-dns.mjs"),
        "--preflight",
        "node-template",
      ],
      {
        env: { ...env, DOMAIN: "cogni-testing.org" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    writeFileSync(
      requestPath,
      JSON.stringify({ ...request, unreviewed: true })
    );
    assert.throws(() => cli("--check"));
    cli("--write");
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
    const origin =
      /path: \/data\/NEXTAUTH_URL\s+value: "?(https:\/\/[^"\s]+)/.exec(shell);
    assert.ok(origin);
    assert.equal(new URL(origin[1]).hostname, "clone-test.cognidao.org");
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
    // Exercise the substrate consumer with nonempty legitimate credential slots:
    // delegated CNAME intent must never enter the legacy apex/A-only API path.
    const appsetDir = path.join(dir, "infra/k8s/argocd/appsets/candidate-a");
    mkdirSync(appsetDir, { recursive: true });
    writeFileSync(
      path.join(appsetDir, "candidate-a-node-template-applicationset.yaml"),
      "{}\n"
    );
    const fakeSsh = path.join(dir, "ssh");
    writeFileSync(fakeSsh, "#!/bin/sh\ncat >/dev/null\nexit 0\n");
    chmodSync(fakeSsh, 0o700);
    const cfAttempt = path.join(dir, "cf-attempt");
    const fakeCf = path.join(dir, "cf");
    writeFileSync(fakeCf, `#!/bin/sh\ntouch '${cfAttempt}'\nexit 97\n`);
    chmodSync(fakeCf, 0o700);
    const substrateOutput = execFileSync(
      "bash",
      ["scripts/ci/assert-target-substrate.sh"],
      {
        env: {
          ...env,
          TARGET: "node-template",
          DEPLOY_ENVIRONMENT: "candidate-a",
          DEPLOYMENT_PROVIDER: "k3s",
          APP_SOURCE_DIR: dir,
          COGNI_CATALOG_ROOT: path.join(dir, "infra/catalog"),
          DOMAIN: "cogni-testing.org",
          VM_HOST: "192.0.2.10",
          CHECK_DNS: "true",
          CLOUDFLARE_API_TOKEN: "fixture-present",
          CLOUDFLARE_ZONE_ID: "a".repeat(32),
          CF_CURL: fakeCf,
          ASSERT_TARGET_SUBSTRATE_SSH_BIN: fakeSsh,
        },
        encoding: "utf8",
      }
    );
    assert.match(substrateOutput, /DNS owned by provider-http/);
    assert.equal(existsSync(cfAttempt), false);
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
    const sharedTemplate = readFileSync(
      "scripts/ci/node-applicationset.yaml.tmpl",
      "utf8"
    )
      .replaceAll("__ENV__", "candidate-a")
      .replaceAll("__NODE__", "node-template")
      .replaceAll(
        "__REPO_URL__",
        "https://github.com/cogni-test-org/cogni-monorepo.git"
      );
    const expectedSpec = JSON.parse(
      execFileSync("yq", ["-o=json", ".", "-"], {
        input: sharedTemplate,
        encoding: "utf8",
      })
    ).spec;
    const hashSpec = (spec) =>
      createHash("sha256")
        .update(
          execFileSync("jq", ["-cS", ".spec"], {
            input: JSON.stringify({ spec }),
          })
        )
        .digest("hex");
    const expectedApplicationSpec = JSON.parse(
      JSON.stringify(expectedSpec.template.spec).replaceAll(
        "{{.name}}",
        "node-template"
      )
    );
    const positive = {
      ...receipt,
      zoneId: "a".repeat(32),
      host: "node-template-test.cogni-testing.org",
      owner: "fixture-owner",
      expectedAppSetSpecHash: hashSpec(expectedSpec),
      expectedApplicationSpecHash: hashSpec(expectedApplicationSpec),
    };
    const fixtureSource = path.join(dir, "expected-source");
    mkdirSync(path.join(fixtureSource, "scripts/ci"), { recursive: true });
    mkdirSync(
      path.join(fixtureSource, "infra/k8s/argocd/appsets/candidate-a"),
      { recursive: true }
    );
    writeFileSync(
      path.join(fixtureSource, "scripts/ci/node-applicationset.yaml.tmpl"),
      readFileSync("scripts/ci/node-applicationset.yaml.tmpl")
    );
    writeFileSync(
      path.join(
        fixtureSource,
        "infra/k8s/argocd/appsets/candidate-a/candidate-a-node-template-applicationset.yaml"
      ),
      JSON.stringify({ spec: expectedSpec })
    );
    const actualExpectedStage = /DNS_PLAN=.*?<<'PY'\n([\s\S]*?)\nPY/.exec(
      readFileSync("scripts/ci/assert-k3s-dns-substrate.sh", "utf8")
    )[1];
    execFileSync(
      "python3",
      ["-c", actualExpectedStage, path.join(dir, "expected-receipt")],
      {
        env: {
          ...process.env,
          APP_SOURCE_DIR: fixtureSource,
          DNS_PLAN: JSON.stringify(positive),
        },
      }
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "expected-receipt"), "utf8"))
        .expectedAppSetSpecHash,
      positive.expectedAppSetSpecHash
    );
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
        templateName: "candidate-a-{{.name}}",
        goTemplate: true,
        project: "default",
        destination: {
          server: "https://kubernetes.default.svc",
          namespace: "cogni-candidate-a",
        },
        uid: "test-appset-uid",
        specHash: hashSpec(expectedSpec),
        generators: [
          {
            git: {
              repoURL: "https://github.com/cogni-test-org/cogni-monorepo.git",
              revision: "deploy/candidate-a-node-template",
              files: [{ path: "infra/catalog/node-template.yaml" }],
            },
          },
        ],
        source: {
          repoURL: "https://github.com/cogni-test-org/cogni-monorepo.git",
          targetRevision: "deploy/candidate-a-{{.name}}",
          path: "infra/k8s/overlays/candidate-a/{{.name}}",
        },
      },
      dnsRequest: { owner: "fixture-owner" },
      appsetAuthorities: [],
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
    assert.equal(
      run(positive, {
        ...known,
        appsetAuthorities: [
          {
            name: "foreign-root",
            source: { repoURL: "https://github.com/cogni-dao/cogni.git" },
          },
        ],
      }).passed,
      false
    );
    const bootstrap = run(positive, known);
    assert.equal(bootstrap.passed, true);
    // Run the ACTUAL production projection, including its whole-spec hash. An
    // unprojected override must still change admission, even when singular source is correct.
    const actualProjection =
      /^appset=.+?jq --arg specHash "\$appset_hash" '([^']+)'\)/m.exec(
        readFileSync("scripts/ci/assert-k3s-dns-substrate.sh", "utf8")
      )[1];
    const project = (spec) =>
      JSON.parse(
        execFileSync(
          "jq",
          ["-c", "--arg", "specHash", hashSpec(spec), actualProjection],
          {
            input: JSON.stringify({
              metadata: {
                name: "cogni-candidate-a-node-template",
                uid: "test-appset-uid",
              },
              spec,
            }),
            encoding: "utf8",
          }
        )
      );
    assert.equal(
      run(positive, { ...known, appset: project(expectedSpec) }).passed,
      true
    );
    const actualAppProjection =
      /^app=.+?jq --arg specHash "\$app_hash" '([^']+)'\)/m.exec(
        readFileSync("scripts/ci/assert-k3s-dns-substrate.sh", "utf8")
      )[1];
    const projectApp = (spec) =>
      JSON.parse(
        execFileSync(
          "jq",
          ["-c", "--arg", "specHash", hashSpec(spec), actualAppProjection],
          {
            input: JSON.stringify({
              metadata: {
                name: "candidate-a-node-template",
                ownerReferences: [
                  {
                    kind: "ApplicationSet",
                    name: "cogni-candidate-a-node-template",
                    uid: "test-appset-uid",
                  },
                ],
              },
              spec,
            }),
            encoding: "utf8",
          }
        )
      );
    assert.equal(
      run(positive, { ...known, app: projectApp(expectedApplicationSpec) })
        .passed,
      true
    );
    const pluralApp = {
      ...expectedApplicationSpec,
      sources: [
        { repoURL: "https://github.com/cogni-dao/cogni.git", path: "foreign" },
      ],
    };
    assert.equal(
      run(positive, { ...known, app: projectApp(pluralApp) }).passed,
      false
    );
    const privateApp = {
      ...expectedApplicationSpec,
      source: {
        ...expectedApplicationSpec.source,
        plugin: {
          env: [{ name: "TOKEN", value: "PRIVATE-SENTINEL-DO-NOT-LOG" }],
        },
      },
    };
    assert.equal(
      JSON.stringify(projectApp(privateApp)).includes(
        "PRIVATE-SENTINEL-DO-NOT-LOG"
      ),
      false
    );
    assert.equal(
      run(positive, { ...known, app: projectApp(privateApp) }).passed,
      false
    );
    const managingCode =
      /^appset_authorities=.+?python3 -c '\n([\s\S]*?)\n' "\$node" "\$env_name"\)/m.exec(
        readFileSync("scripts/ci/assert-k3s-dns-substrate.sh", "utf8")
      )[1];
    const rootSource = {
      repoURL: "https://github.com/cogni-test-org/cogni-monorepo.git",
      targetRevision: "main",
      path: "infra/k8s/argocd/appsets/candidate-a",
    };
    const rootDestination = {
      server: "https://kubernetes.default.svc",
      namespace: "argocd",
    };
    const manage = (spec) =>
      JSON.parse(
        execFileSync(
          "python3",
          ["-c", managingCode, "node-template", "candidate-a"],
          {
            input: JSON.stringify({
              items: [
                {
                  metadata: { name: "test-appsets" },
                  status: {
                    resources: [
                      {
                        kind: "ApplicationSet",
                        name: "cogni-candidate-a-node-template",
                      },
                    ],
                  },
                  spec,
                },
              ],
            }),
            encoding: "utf8",
          }
        )
      );
    const rootSpec = { source: rootSource, destination: rootDestination };
    assert.equal(
      run(positive, {
        ...known,
        appset: { ...known.appset, argoInstance: "test-appsets" },
        appsetAuthorities: manage(rootSpec),
      }).passed,
      true
    );
    for (const spec of [
      { ...rootSpec, sources: [{ repoURL: "foreign" }] },
      {
        ...rootSpec,
        source: {
          ...rootSource,
          plugin: {
            env: [{ name: "TOKEN", value: "PRIVATE-SENTINEL-DO-NOT-LOG" }],
          },
        },
      },
    ]) {
      const projected = manage(spec);
      assert.equal(
        JSON.stringify(projected).includes("PRIVATE-SENTINEL-DO-NOT-LOG"),
        false
      );
      assert.equal(
        run(positive, { ...known, appsetAuthorities: projected }).passed,
        false
      );
    }
    for (const mutate of [
      (s) => {
        s.generators[0].git.files = [{ path: "infra/catalog/foreign.yaml" }];
      },
      (s) => {
        s.template.spec.source.path = "infra/k8s/overlays/production/operator";
      },
      (s) => {
        s.template.spec.destination.namespace = "cogni-production";
      },
      (s) => {
        s.template.metadata.name = "production-operator";
      },
      (s) => {
        s.template.spec.sources = [
          {
            repoURL: "https://github.com/cogni-dao/cogni.git",
            targetRevision: "main",
            path: "infra/k8s/overlays/production/operator",
          },
        ];
      },
      (s) => {
        s.templatePatch = "spec: {sources: [{repoURL: foreign}]}";
      },
      (s) => {
        s.generators[0].template = { spec: { source: { path: "foreign" } } };
      },
      (s) => {
        s.template.spec.source.plugin = {
          name: "unreviewed",
          env: [{ name: "TOKEN", value: "PRIVATE-SENTINEL-DO-NOT-LOG" }],
        };
      },
    ]) {
      const changed = structuredClone(expectedSpec);
      mutate(changed);
      assert.equal(
        JSON.stringify(project(changed)).includes(
          "PRIVATE-SENTINEL-DO-NOT-LOG"
        ),
        false
      );
      assert.equal(
        run(positive, { ...known, appset: project(changed) }).passed,
        false
      );
    }
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
