// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-workload-spec`
 * Purpose: Build the provider-agnostic ProvisionSpec for running ONE node-app container on
 *   decentralized compute, wired back to the SHARED infra substrate (task.5044 v000): the
 *   app dials the env VM's postgres/doltgres/redis/temporal/litellm and the cluster
 *   scheduler-worker NodePort — the same endpoints the k8s ExternalName services encode.
 * Scope: Pure spec construction. Does NOT render provider manifests (adapter's job), read
 *   OpenBao, or persist anything. The caller supplies the node's real connection env.
 * Invariants:
 *   - APP_ONLY_NO_INFRA_ON_DECENTRALIZED_COMPUTE (Derek, 2026-08-31): the workload is the
 *     node-app container ONLY. Databases, Temporal, Redis, LiteLLM stay on the existing
 *     Cherry substrate; running them as workload sidecars is the rejected anti-pattern.
 *   - SHARED_STATE: pointing at the env's real per-node DSNs means no migrations in the
 *     workload and state shared with the k8s deployment of the same node.
 *   - SCOPED_CREDS_ONLY: callers must pass node-scoped/budget-capped credentials (per-node
 *     DB roles, LiteLLM VIRTUAL key, write-only Loki key) — never a master/fleet secret.
 *   - LOG_PUMP_IS_V000_EXCEPTION: piping app stdout through an inline Loki pusher is the
 *     zero-image-change stopgap; the proper env-gated transport in node-template is v0
 *     scope. Labels mirror Alloy ({env, service:"app", node:<nodeId>}) so the operator
 *     observability proxy reads decentralized-compute lines unmodified. NOTE: the deploy
 *     route does not wire `logPush` yet (operator-admin drivers do); route wiring lands
 *     with server-side env sourcing (v0).
 * Side-effects: none (pure)
 * Links: ProvisionSpec (@cogni/ai-tools), AkashComputeAdapter (adapters/server/compute),
 *   infra/k8s/overlays/<env>/<node>/ (the ExternalName wiring this mirrors),
 *   docs/guides/agent-api-validation.md (the flow this workload must serve)
 * @internal
 */

import type { ProvisionSpec } from "@cogni/ai-tools";

export interface NodeWorkloadLogPush {
  /** Loki push endpoint (e.g. https://logs-prod-021.grafana.net/loki/api/v1/push). */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** Value for the `env` stream label (must match the operator env that reads it). */
  readonly env: string;
}

export interface NodeWorkloadInput {
  /** Node slug (workload label). */
  readonly slug: string;
  /** Node UUID — the Loki `node` stream label the observability proxy forces. */
  readonly nodeId: string;
  /** Fully-qualified node-app image ref (public registry; repo-spec + PORT baked in). */
  readonly image: string;
  /** Container port the node app listens on (baked into the fork's image). */
  readonly port: number;
  /** Public base URL the app should consider canonical (NEXTAUTH_URL/APP_BASE_URL). */
  readonly publicUrl: string;
  /** Custom hostnames the provider ingress should accept (CNAME targets). */
  readonly hosts?: readonly string[];
  /**
   * The node's connection + secret env (DSNs to the shared substrate, AUTH_SECRET,
   * LITELLM_* etc.). SCOPED_CREDS_ONLY — node-scoped and budget-capped values only.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Workload sizing; defaults suit a standard node (~$2/mo at observed bids). */
  readonly resources?: {
    readonly cpuUnits: number;
    readonly memoryMi: number;
    readonly storageMi: number;
  };
  /** Enable the stdout→Loki pump (v000 exception; see LOG_PUMP_IS_V000_EXCEPTION). */
  readonly logPush?: NodeWorkloadLogPush;
}

export function buildNodeAppIdentityEnv(input: {
  slug: string;
  publicUrl: string;
  env: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    ...input.env,
    NODE_NAME: input.slug,
    COGNI_REPO_PATH: "/app",
    AUTH_TRUST_HOST: "true",
    NEXTAUTH_URL: input.publicUrl,
    APP_BASE_URL: input.publicUrl,
  };
}

/** Inline stdin→Loki batch pusher, run behind the app's stdout pipe (node builtins only). */
function lokiPumpJs(): string {
  return [
    "const https=require('https');const {URL}=require('url');",
    "const u=new URL(process.env.LOKI_PUSH_URL);",
    "const auth='Basic '+Buffer.from(process.env.LOKI_PUSH_USER+':'+process.env.LOKI_PUSH_PASSWORD).toString('base64');",
    "const labels={env:process.env.LOKI_PUSH_ENV,service:'app',node:process.env.LOKI_PUSH_NODE,source:'akash'};",
    "let buf=[];",
    "function flush(){if(!buf.length)return;const body=JSON.stringify({streams:[{stream:labels,values:buf}]});buf=[];",
    "const req=https.request({host:u.hostname,path:u.pathname,method:'POST',headers:{'content-type':'application/json',authorization:auth}},r=>r.resume());",
    "req.on('error',()=>{});req.end(body);}",
    "setInterval(flush,2000);",
    "let acc='';process.stdin.on('data',d=>{acc+=d;const lines=acc.split('\\n');acc=lines.pop()||'';",
    "for(const l of lines){if(!l)continue;console.log(l);buf.push([String(Date.now())+'000000',l]);if(buf.length>500)flush();}});",
    "process.stdin.on('end',()=>{flush();setTimeout(()=>process.exit(0),3000);});",
  ].join("");
}

/** Build the app-only workload spec for one node wired to shared infra. */
export function buildNodeWorkloadSpec(input: NodeWorkloadInput): ProvisionSpec {
  const appEnv = buildNodeAppIdentityEnv({
    slug: input.slug,
    publicUrl: input.publicUrl,
    env: input.env,
  });

  // The pump source travels base64 in env and is materialized to a file at start —
  // zero shell-quoting/escaping of code (js/incomplete-sanitization safe by construction).
  const appCommand = input.logPush
    ? [
        "/bin/sh",
        "-c",
        'printf %s "$LOKI_PUMP_B64" | base64 -d > /tmp/loki-pump.js && node /app/app/server.js 2>&1 | node /tmp/loki-pump.js',
      ]
    : undefined;
  if (input.logPush) {
    appEnv.LOKI_PUMP_B64 = Buffer.from(lokiPumpJs(), "utf8").toString("base64");
    appEnv.LOKI_PUSH_URL = input.logPush.url;
    appEnv.LOKI_PUSH_USER = input.logPush.username;
    appEnv.LOKI_PUSH_PASSWORD = input.logPush.password;
    appEnv.LOKI_PUSH_ENV = input.logPush.env;
    appEnv.LOKI_PUSH_NODE = input.nodeId;
  }

  const resources = input.resources ?? {
    // Production default: nodes are user-facing website endpoints. 0.5 vCPU/1024Mi
    // starved Next.js SSR (~2-4s /readyz measured on toks4, bug.5088). Sized for prod;
    // heavier nodes override via input.resources.
    cpuUnits: 2,
    memoryMi: 2048,
    storageMi: 2048,
  };

  return {
    name: input.slug,
    services: [
      {
        name: "app",
        image: input.image,
        env: appEnv,
        ...(appCommand ? { command: appCommand } : {}),
        ...resources,
        expose: [
          {
            port: input.port,
            as: 80,
            global: true,
            ...(input.hosts && input.hosts.length > 0
              ? { hosts: input.hosts }
              : {}),
          },
        ],
      },
    ],
  };
}
