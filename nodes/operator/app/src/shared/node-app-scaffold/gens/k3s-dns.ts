// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@shared/node-app-scaffold/gens/k3s-dns`
 * Purpose: Project explicit catalog DNS intent into one namespaced provider-http Request.
 * Scope: Pure validated data projection. Does not read credentials, access providers or mutate state.
 * Invariants: Absent intent is inert; fixed CNAME create; current owner/cardinality errors block updates.
 * Side-effects: none
 * Links: bug.5526, isolated-k3s-workload-dns
 * @public
 */
type Row = Record<string, unknown>;
const lanes = new Set(["candidate-a", "preview", "production"]);
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("dns_intent_object_required");
  return value as Row;
}
function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function domain(value: string): string {
  requireThat(
    value.length > 0 &&
      value.length <= 253 &&
      value
        .split(".")
        .every(
          (label) =>
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
        ),
    "dns_domain_invalid"
  );
  return value;
}
/** Byte-equivalent domain boundary to k3s_workload_domain in the catalog shell API. */
export function k3sWorkloadDomain(
  control: string,
  workload: string,
  root: string
): string {
  domain(control);
  domain(workload);
  domain(root);
  if (control === workload) return control;
  if (control === root) return workload;
  requireThat(control.endsWith(`.${root}`), "dns_control_root_mismatch");
  requireThat(
    !workload.endsWith(`.${root}`),
    "dns_workload_environment_mismatch"
  );
  const prefix = control.slice(0, -root.length - 1);
  return domain(
    workload.startsWith(`${prefix}.`) ? workload : `${prefix}.${workload}`
  );
}

/** Resolve only explicit, environment-scoped catalog intent; unknown modes never fall back. */
export function k3sDnsIntent(catalog: unknown, environment: string) {
  const row = object(catalog);
  if (row.k3s_dns === undefined) return null;
  const all = object(row.k3s_dns);
  requireThat(
    Object.keys(all).every((key) => lanes.has(key)),
    "dns_intent_environment_invalid"
  );
  if (all[environment] === undefined) return null;
  const intent = object(all[environment]);
  requireThat(
    Object.keys(intent).length === 4 &&
      Object.keys(intent).every((key) =>
        ["mode", "zoneId", "target", "workloadDomain"].includes(key)
      ),
    "dns_intent_fields_invalid"
  );
  requireThat(intent.mode === "crossplane-http", "dns_writer_invalid");
  requireThat(
    typeof intent.zoneId === "string" && /^[0-9a-f]{32}$/.test(intent.zoneId),
    "dns_zone_id_invalid"
  );
  requireThat(typeof intent.target === "string", "dns_target_invalid");
  domain(intent.target);
  requireThat(
    typeof intent.workloadDomain === "string",
    "dns_workload_domain_invalid"
  );
  domain(intent.workloadDomain);
  requireThat(
    row.type === "node" &&
      row.is_primary_host !== true &&
      typeof row.name === "string" &&
      /^[a-z][a-z0-9-]{0,62}$/.test(row.name) &&
      !["www", "operator"].includes(row.name),
    "dns_node_identity_invalid"
  );
  requireThat(
    Array.isArray(row.envs) && row.envs.includes(environment),
    "dns_environment_not_deployed"
  );
  const providers =
    row.deployment_provider === undefined
      ? {}
      : object(row.deployment_provider);
  requireThat(
    (providers[environment] ?? "k3s") === "k3s",
    "dns_placement_conflict"
  );
  return {
    mode: "crossplane-http" as const,
    zoneId: intent.zoneId,
    target: intent.target,
    workloadDomain: intent.workloadDomain,
  };
}
const liveValid =
  '(.response.statusCode == 200 and .response.body.success == true and (.response.body.result | type) == "array" and .response.body.result_info.total_count == (.response.body.result | length))';
const owned =
  '((.response.body.result | length) == 1 and .response.body.result[0].name == .payload.body.name and (.response.body.result[0].type == "A" or .response.body.result[0].type == "AAAA" or .response.body.result[0].type == "CNAME") and .response.body.result[0].comment == .payload.body.comment and (.response.body.result[0].id | type) == "string" and (.response.body.result[0].id | test("^[a-f0-9]{32}$")))';
const removed = `if ${liveValid} | not then error("dns_observation_invalid") elif (.response.body.result | length) == 0 then true elif ${owned} then false else error("dns_ownership_conflict") end`;
const ownedUrl = `if ${liveValid} and ${owned} then (.payload.baseUrl + "/" + .response.body.result[0].id) else error("dns_ownership_conflict") end`;

/** Build a DNS-only resource; caller owns serialization and its per-node overlay reference. */
export function buildK3sDnsRequest(input: {
  catalog: unknown;
  environment: string;
  repository: string;
  nodeId: string;
  controlDomain: string;
  workloadDomain: string;
  substrateRoot: string;
}) {
  const intent = k3sDnsIntent(input.catalog, input.environment);
  if (!intent) return null;
  const row = object(input.catalog);
  requireThat(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository),
    "dns_repository_invalid"
  );
  requireThat(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.nodeId),
    "dns_node_uuid_invalid"
  );
  requireThat(
    input.workloadDomain === intent.workloadDomain,
    "dns_workload_domain_mismatch"
  );
  requireThat(
    intent.workloadDomain !== input.substrateRoot &&
      !intent.workloadDomain.endsWith(`.${input.substrateRoot}`),
    "dns_workload_zone_not_isolated"
  );
  const base = k3sWorkloadDomain(
    input.controlDomain,
    intent.workloadDomain,
    input.substrateRoot
  );
  const host = domain(
    base.split(".").length >= 3 ? `${row.name}-${base}` : `${row.name}.${base}`
  );
  requireThat(
    host !== input.controlDomain && !host.startsWith("www."),
    "dns_protected_name"
  );
  const owner = `cogni:${input.repository}:${input.nodeId}:${input.environment}`;
  const namespace = `cogni-${input.environment}`;
  const body = {
    type: "CNAME",
    name: host,
    content: intent.target,
    ttl: 1,
    proxied: true,
    comment: owner,
  };
  return {
    apiVersion: "http.m.crossplane.io/v1alpha2",
    kind: "Request",
    metadata: {
      name: "workload-dns",
      namespace,
      annotations: {
        "cogni.io/dns-owner": owner,
        "argocd.argoproj.io/sync-wave": "1",
      },
    },
    spec: {
      providerConfigRef: { kind: "ClusterProviderConfig", name: "cogni-http" },
      forProvider: {
        waitTimeout: "30s",
        headers: {
          "Content-Type": ["application/json"],
          Authorization: [
            `Bearer {{ operator-env-secrets:${namespace}:CLOUDFLARE_API_TOKEN }}`,
          ],
        },
        payload: {
          baseUrl: `https://api.cloudflare.com/client/v4/zones/${intent.zoneId}/dns_records`,
          body: JSON.stringify(body),
        },
        mappings: [
          {
            action: "OBSERVE",
            method: "GET",
            url: '(.payload.baseUrl + "?name=" + .payload.body.name + "&per_page=100")',
          },
          // Initial non2xx/empty Observe may not persist a response: create is fixed POST, never upsert.
          {
            action: "CREATE",
            method: "POST",
            url: ".payload.baseUrl",
            body: ".payload.body",
          },
          {
            action: "UPDATE",
            method: "PUT",
            url: ownedUrl,
            body: ".payload.body",
          },
          { action: "REMOVE", method: "DELETE", url: ownedUrl },
        ],
        isRemovedCheck: { type: "CUSTOM", logic: removed },
        expectedResponseCheck: {
          type: "CUSTOM",
          logic: `${liveValid} and ${owned} and (.response.body.result[0].type == .payload.body.type and .response.body.result[0].content == .payload.body.content and .response.body.result[0].proxied == true)`,
        },
      },
    },
  };
}

/** Remove only this generator's exact opt-in additions before cloning a template. */
export function stripK3sDnsProjection(text: string): string {
  return text
    .replace(/^ {2}- k3s-dns-request\.json\n/gm, "")
    .replace(
      /^ {2}# BEGIN generated k3s DNS origin\n[\s\S]*?^ {2}# END generated k3s DNS origin\n/gm,
      ""
    );
}
/** Add the origin after existing patches so the catalog projection is authoritative. */
export function projectK3sDnsOverlay(text: string, host: string): string {
  domain(host);
  text = stripK3sDnsProjection(text);
  requireThat(/^resources:\s*\n/m.test(text), "dns_overlay_resources_missing");
  text = text.replace(/^(resources:\s*\n)/m, "$1  - k3s-dns-request.json\n");
  const lines = text.split("\n");
  const start = lines.indexOf("patches:");
  requireThat(start >= 0, "dns_overlay_patches_missing");
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z][^:]*:/.test(lines[end] ?? "")) end++;
  if (end === lines.length && lines[end - 1] === "") end--;
  lines.splice(
    end,
    0,
    "  # BEGIN generated k3s DNS origin",
    "  - target:",
    "      kind: ConfigMap",
    "      name: node-app-config",
    "    patch: |",
    "      - op: replace",
    "        path: /data/NEXTAUTH_URL",
    `        value: "https://${host}"`,
    "  # END generated k3s DNS origin"
  );
  return lines.join("\n");
}
