// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/external-dns-control-plane`
 * Purpose: Pins bug.5181's staged, OSS-owned DNS adoption boundary.
 * Scope: Static manifests only; does NOT contact a cluster or Cloudflare.
 * Invariants: PINNED_UPSTREAM_RECONCILER, EXACT_SOURCE_FILTERS, SCOPED_CREDS_ONLY,
 *   IMPORTER_CANNOT_DELETE, CANDIDATE_BEFORE_PRODUCTION.
 * Side-effects: IO (reads repo manifests)
 * Links: bug.5181, story.5016, infra/crossplane/AGENTS.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
type YamlObject = Record<string, unknown>;

function readYaml(relativePath: string): YamlObject {
  return parse(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
  ) as YamlObject;
}

function application(environment: string, name: string): YamlObject {
  return readYaml(
    `infra/k8s/argocd/control-plane/${environment}/${name}-application.yaml`
  );
}

function source(applicationObject: YamlObject): YamlObject {
  return (applicationObject.spec as YamlObject).source as YamlObject;
}

function values(applicationObject: YamlObject): YamlObject {
  return parse(
    ((source(applicationObject).helm as YamlObject).values as string) ?? ""
  ) as YamlObject;
}

const environments = ["candidate-a", "production"] as const;
const expectedImage =
  "v0.22.0@sha256:5fdcaf7deb5c158f93a1fc6fe169cdff4cfb9ae0172bee1a90ab0ef74fb9c9cf";

describe("ExternalDNS control plane (bug.5181 Stage A)", () => {
  it("pins the official chart and image identically in candidate and production", () => {
    for (const environment of environments) {
      for (const name of ["external-dns", "external-dns-importer"]) {
        const app = application(environment, name);
        expect(source(app)).toMatchObject({
          repoURL: "https://kubernetes-sigs.github.io/external-dns/",
          chart: "external-dns",
          targetRevision: "1.22.0",
        });
        expect((values(app).image as YamlObject).tag).toBe(expectedImage);
      }
    }
  });

  it("gives the steady controller exact source, zone, domain and record-type bounds", () => {
    for (const environment of environments) {
      const configured = values(application(environment, "external-dns"));
      expect(configured).toMatchObject({
        sources: ["crd"],
        provider: { name: "cloudflare" },
        policy: "sync",
        registry: "txt",
        txtOwnerId: `cogni-${environment}-xcw`,
        txtPrefix: "xcw-%{record_type}-",
        domainFilters: ["cognidao.org"],
        labelFilter: "cogni.io/dns-role=record",
        managedRecordTypes: ["CNAME"],
      });
      expect(configured.extraArgs).toContain(
        "--zone-id-filter=$(CLOUDFLARE_ZONE_ID)"
      );
    }
  });

  it("makes the temporary importer TXT-only, label-scoped and unable to delete", () => {
    for (const environment of environments) {
      const app = application(environment, "external-dns-importer");
      expect((source(app).helm as YamlObject).skipCrds).toBe(true);
      expect(values(app)).toMatchObject({
        sources: ["crd"],
        provider: { name: "cloudflare" },
        policy: "upsert-only",
        registry: "noop",
        domainFilters: ["cognidao.org"],
        labelFilter: "cogni.io/dns-role=import",
        managedRecordTypes: ["TXT"],
      });
    }
  });

  it("projects only the Cloudflare token and public zone id", () => {
    const secret = readYaml(
      "infra/k8s/argocd/external-dns/base/external-secret.yaml"
    );
    const spec = secret.spec as YamlObject;
    expect(spec).not.toHaveProperty("dataFrom");
    expect(
      (spec.data as { secretKey: string; remoteRef: YamlObject }[]).map(
        ({ secretKey, remoteRef }) => [secretKey, remoteRef.property]
      )
    ).toEqual([
      ["api-token", "CLOUDFLARE_API_TOKEN"],
      ["zone-id", "CLOUDFLARE_ZONE_ID"],
    ]);
  });

  it("lets only candidate track an unmerged config tree", () => {
    expect(
      source(application("candidate-a", "external-dns-config")).targetRevision
    ).toBe("deploy/candidate-a-control-plane");
    expect(
      source(application("production", "external-dns-config")).targetRevision
    ).toBe("main");
  });

  it("grants Crossplane only DNSEndpoint lifecycle verbs", () => {
    const role = readYaml(
      "infra/k8s/argocd/external-dns/base/crossplane-rbac.yaml"
    );
    expect((role.metadata as YamlObject).labels).toEqual({
      "rbac.crossplane.io/aggregate-to-crossplane": "true",
    });
    expect(role.rules).toEqual([
      {
        apiGroups: ["externaldns.k8s.io"],
        resources: ["dnsendpoints"],
        verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
      },
    ]);
  });
});
