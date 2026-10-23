// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/worker-custodied-routing`
 * Purpose: Fixed service-owned routing publication and receipt rollback.
 * Scope: One candidate subsection on the existing production worker ref; Git publication only.
 * Invariants: Protected immutable generated authority, additive admission, bounded Contents CAS,
 *   same-App signed receipt provenance, unrelated bytes preserved, no cluster/image mutation.
 * Side-effects: GitHub reads and Contents writes through the configured operator installation.
 * Links: spike.5010, docs/spec/cicd-platform-boundary.md
 * @internal
 */
import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/core";
import { parseDocument } from "yaml";
import { z } from "zod";

export const WORKER_ROUTING_TARGET = "scheduler-worker-custodied-routing";
export const WORKER_ROUTING_REF = "deploy/production-scheduler-worker";
export const WORKER_ROUTING_PATH =
  "infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml";
const FIELD = "TEMPORAL_CUSTODIED_NODE_ENDPOINTS";
const NS = "cogni-candidate-a";
const PREFIX = "Cogni-Worker-Routing-v1: ";
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const inputSchema = z.strictObject({
  env: z.literal("production"),
  slug: z.literal("operator"),
  parentOwner: z.string().min(1),
  parentRepo: z.string().min(1),
  target: z.literal(WORKER_ROUTING_TARGET),
  rollbackReceipt: Sha.optional(),
});
const receiptSchema = z.strictObject({
  version: z.literal(1),
  target: z.literal(WORKER_ROUTING_TARGET),
  authoritySha: Sha,
  beforeBlob: Sha,
  afterBlob: Sha,
  beforeHash: Hash,
  afterHash: Hash,
});
const publicationResultSchema = receiptSchema
  .extend({
    status: z.enum(["unchanged", "git_published"]),
    env: z.literal("production"),
    sourceSha: Sha,
    deploySha: Sha,
    deployRef: z.literal(WORKER_ROUTING_REF),
    path: z.literal(WORKER_ROUTING_PATH),
    receipt: Sha.nullable(),
    rollbackReceipt: Sha.nullable(),
  })
  .strict();
const contentsSchema = z.object({
  type: z.literal("file"),
  sha: Sha,
  encoding: z.literal("base64"),
  content: z.string().max(200000),
});
export type WorkerRoutingInput = z.infer<typeof inputSchema>;
export interface WorkerRoutingConfig {
  hostingEnv?: string | undefined;
  fleetControlEnv?: string | undefined;
  parentOwner?: string | undefined;
  parentRepo?: string | undefined;
}
export function routingError(message: string): never {
  throw Object.assign(new Error(message), {
    code: "worker_routing_refused",
    status: 409,
  });
}
function hash(value: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}
function blob(text: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");
}
const token = String.raw`"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"`;
/** JSON string-only object with duplicate detection and the exact candidate value span. */
function jsonMap(raw: string) {
  const entries = [
    ...raw.matchAll(new RegExp(`(${token})\\s*:\\s*(${token})`, "g")),
  ];
  const parsed = z
    .record(z.string().regex(/^cogni-[a-z][a-z0-9-]*$/), z.string().max(64000))
    .parse(JSON.parse(raw));
  if (entries.length !== Object.keys(parsed).length)
    routingError("duplicate or invalid namespace");
  const keys = entries.map((m) => JSON.parse(m[1] ?? ""));
  if (new Set(keys).size !== keys.length) routingError("duplicate namespace");
  const match = entries.find((m) => JSON.parse(m[1] ?? "") === NS);
  return { parsed, match };
}
/** Validate complete canonical slug/UUID pairs without re-deriving the catalog inventory. */
export function candidateAliases(csv: string): Map<string, string> {
  const parts = csv ? csv.split(",") : [];
  if (parts.length > 1024 || parts.length % 2)
    routingError("unpaired candidate aliases");
  const aliases = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2) {
    const pair = [parts[i], parts[i + 1]].map((p) => {
      const m = /^([^=]+)=(https:\/\/[^,=]+)$/.exec(p ?? "");
      if (!m) return routingError("invalid candidate endpoint");
      const key = m[1] ?? "",
        value = m[2] ?? "",
        url = new URL(value);
      if (
        url.origin !== value ||
        url.username ||
        url.password ||
        url.protocol !== "https:" ||
        url.port ||
        url.hostname !== url.hostname.toLowerCase()
      )
        routingError("noncanonical HTTPS endpoint");
      if (aliases.has(key)) routingError("duplicate candidate alias");
      aliases.set(key, value);
      return { key, value };
    });
    const slug = pair[0],
      uuid = pair[1];
    if (
      !slug ||
      !uuid ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug.key) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        uuid.key
      ) ||
      slug.value !== uuid.value
    )
      routingError("candidate slug/UUID pair mismatch");
  }
  return aliases;
}
export function readWorkerPatch(text: string) {
  if (Buffer.byteLength(text) > 128000 || text.includes("\r"))
    routingError("oversized or noncanonical patch");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) routingError("invalid worker YAML");
  const data = z
    .strictObject({
      apiVersion: z.literal("v1"),
      kind: z.literal("ConfigMap"),
      metadata: z.strictObject({ name: z.literal("scheduler-worker-config") }),
      data: z.record(z.string(), z.string()),
    })
    .parse(doc.toJS({ maxAliasCount: 0 }));
  const matches = [
    ...text.matchAll(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS: (.*)$/gm),
  ];
  const line = matches[0],
    scalar = line?.[1];
  if (
    matches.length !== 1 ||
    !line ||
    !scalar ||
    !(scalar === '"{}"' || /^'(?:[^']|'')*'$/.test(scalar))
  )
    routingError("expected generated quoted custody field");
  const raw =
    scalar === '"{}"' ? "{}" : scalar.slice(1, -1).replaceAll("''", "'");
  if (data.data[FIELD] !== raw) routingError("ambiguous custody field");
  const map = jsonMap(raw);
  const selected = map.parsed[NS];
  candidateAliases(selected ?? "");
  return { text, raw, line, map, selected };
}
/** Replace just the JSON candidate value; retain all other bytes including other namespaces. */
export function selectCandidate(
  text: string,
  selected: string | undefined
): string {
  const p = readWorkerPatch(text),
    m = p.map.match;
  if (p.selected === selected) return text;
  let raw = p.raw;
  if (m) {
    const value = m[2] ?? "";
    const start = (m.index ?? 0) + m[0].lastIndexOf(value);
    if (selected === undefined) {
      // The renderer emits a namespace only when nonempty. Remove only this member and its comma.
      let begin = m.index ?? 0,
        end = begin + m[0].length;
      if (/^\s*,/.test(raw.slice(end)))
        end += raw.slice(end).match(/^\s*,/)?.[0].length ?? 0;
      else {
        const comma = raw.slice(0, begin).match(/,\s*$/);
        if (comma) begin -= comma[0].length;
      }
      raw = raw.slice(0, begin) + raw.slice(end);
    } else
      raw =
        raw.slice(0, start) +
        JSON.stringify(selected) +
        raw.slice(start + value.length);
  } else if (selected !== undefined) {
    const at = raw.lastIndexOf("}");
    raw =
      raw.slice(0, at) +
      (Object.keys(p.map.parsed).length ? "," : "") +
      JSON.stringify(NS) +
      ":" +
      JSON.stringify(selected) +
      raw.slice(at);
  }
  const next =
    text.slice(0, p.line.index) +
    `  ${FIELD}: '${raw.replaceAll("'", "''")}'` +
    text.slice((p.line.index ?? 0) + p.line[0].length);
  if (readWorkerPatch(next).selected !== selected)
    routingError("candidate roundtrip failed");
  return next;
}
export function addApprovedCandidate(text: string, authority: string): string {
  const desired = candidateAliases(readWorkerPatch(authority).selected ?? "");
  if (desired.size === 0)
    routingError("protected authority has no candidate aliases");
  const current = readWorkerPatch(text),
    aliases = candidateAliases(current.selected ?? "");
  for (const [key, value] of aliases)
    if (desired.get(key) !== value)
      routingError("selected alias conflicts with protected authority");
  let next = current.selected ?? "";
  for (const [key, value] of desired)
    if (!aliases.has(key)) next += `${next ? "," : ""}${key}=${value}`;
  return next === current.selected ? text : selectCandidate(text, next);
}

export async function reconcileWorkerRouting(
  untrusted: WorkerRoutingInput,
  config: WorkerRoutingConfig,
  getClient: () => Promise<Octokit>,
  getBotIdentity: (client: Octokit) => Promise<{ login: string; id: number }>
) {
  const input = inputSchema.parse(untrusted);
  if (
    config.hostingEnv !== "production" ||
    config.fleetControlEnv !== "production" ||
    !config.parentOwner ||
    !config.parentRepo ||
    input.parentOwner !== config.parentOwner ||
    input.parentRepo !== config.parentRepo
  )
    routingError("production own-custodian parent required");
  const client = await getClient(),
    owner = input.parentOwner,
    repo = input.parentRepo;
  const request = async (route: string, params: Record<string, unknown> = {}) =>
    (await client.request(route, { owner, repo, ...params })).data;
  const main = z
    .object({ protected: z.literal(true), commit: z.object({ sha: Sha }) })
    .parse(
      await request("GET /repos/{owner}/{repo}/branches/{branch}", {
        branch: "main",
      })
    );
  const authoritySha = main.commit.sha;
  const read = async (ref: string) => {
    const data = contentsSchema.parse(
      await request("GET /repos/{owner}/{repo}/contents/{path}", {
        path: WORKER_ROUTING_PATH,
        ref,
      })
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    if (blob(text) !== data.sha) routingError("blob integrity mismatch");
    readWorkerPatch(text);
    return { text, sha: data.sha };
  };
  const authority = await read(authoritySha);
  let rollback: { selected: string | undefined; postHash: string } | undefined;
  if (input.rollbackReceipt) {
    const botIdentity = await getBotIdentity(client);
    const commit = z
      .object({
        sha: Sha,
        parents: z.array(z.object({ sha: Sha })).length(1),
        author: z.object({
          login: z.string(),
          id: z.number().int().positive(),
          type: z.literal("Bot"),
        }),
        committer: z.object({
          login: z.string(),
          id: z.number().int().positive(),
        }),
        commit: z.object({
          message: z.string().max(4096),
          committer: z.object({ name: z.string(), email: z.string() }),
          verification: z.object({
            verified: z.literal(true),
            reason: z.literal("valid"),
          }),
        }),
        files: z
          .array(
            z.object({
              filename: z.literal(WORKER_ROUTING_PATH),
              status: z.literal("modified"),
            })
          )
          .length(1),
      })
      .parse(
        await request("GET /repos/{owner}/{repo}/commits/{ref}", {
          ref: input.rollbackReceipt,
        })
      );
    if (
      commit.sha !== input.rollbackReceipt ||
      commit.author.login !== botIdentity.login ||
      commit.author.id !== botIdentity.id ||
      !(
        (commit.committer.login === botIdentity.login &&
          commit.committer.id === botIdentity.id) ||
        (commit.committer.login === "web-flow" &&
          commit.committer.id === 19864447 &&
          commit.commit.committer.name === "GitHub" &&
          commit.commit.committer.email === "noreply@github.com")
      )
    )
      routingError("receipt is not signed by this operator App");
    const lines = commit.commit.message
      .split("\n")
      .filter((l) => l.startsWith(PREFIX));
    if (lines.length !== 1) routingError("missing routing publication receipt");
    const receipt = receiptSchema.parse(
      JSON.parse((lines[0] ?? "").slice(PREFIX.length))
    );
    const reachable = z.object({ status: z.enum(["ahead", "identical"]) });
    reachable.parse(
      await request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        basehead: `${commit.sha}...${WORKER_ROUTING_REF}`,
      })
    );
    reachable.parse(
      await request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        basehead: `${receipt.authoritySha}...${authoritySha}`,
      })
    );
    const before = await read(commit.parents[0]?.sha ?? ""),
      after = await read(commit.sha),
      originalAuthority = await read(receipt.authoritySha);
    if (
      receipt.beforeBlob !== before.sha ||
      receipt.afterBlob !== after.sha ||
      receipt.beforeHash !== hash(readWorkerPatch(before.text).selected) ||
      receipt.afterHash !== hash(readWorkerPatch(after.text).selected) ||
      addApprovedCandidate(before.text, originalAuthority.text) !==
        after.text ||
      before.text === after.text
    )
      routingError("receipt transaction does not reproduce");
    rollback = {
      selected: readWorkerPatch(before.text).selected,
      postHash: receipt.afterHash,
    };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = z.object({ object: z.object({ sha: Sha }) }).parse(
      await request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ref: `heads/${WORKER_ROUTING_REF}`,
      })
    );
    const current = await read(head.object.sha);
    const before = readWorkerPatch(current.text).selected;
    if (rollback && hash(before) !== rollback.postHash)
      routingError("rollback candidate subsection drifted");
    const next = rollback
      ? selectCandidate(current.text, rollback.selected)
      : addApprovedCandidate(current.text, authority.text);
    const evidence = {
      version: 1 as const,
      target: WORKER_ROUTING_TARGET as typeof WORKER_ROUTING_TARGET,
      authoritySha,
      beforeBlob: current.sha,
      afterBlob: blob(next),
      beforeHash: hash(before),
      afterHash: hash(readWorkerPatch(next).selected),
    };
    const common = {
      env: "production" as const,
      sourceSha: authoritySha,
      deployRef: WORKER_ROUTING_REF as typeof WORKER_ROUTING_REF,
      path: WORKER_ROUTING_PATH,
      rollbackReceipt: input.rollbackReceipt ?? null,
      ...evidence,
    };
    if (next === current.text) {
      return publicationResultSchema.parse({
        ...common,
        status: "unchanged",
        deploySha: head.object.sha,
        receipt: null,
      });
    }
    let response: unknown;
    try {
      response = await request("PUT /repos/{owner}/{repo}/contents/{path}", {
        path: WORKER_ROUTING_PATH,
        branch: WORKER_ROUTING_REF,
        sha: current.sha,
        content: Buffer.from(next).toString("base64"),
        message: `${rollback ? "Restore prior" : "Add approved"} worker candidate routing\n\n${rollback ? `Cogni-Worker-Routing-Rollback-v1: ${input.rollbackReceipt}` : PREFIX + JSON.stringify(evidence)}`,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 409 || attempt === 2)
        throw error;
      continue;
    }
    // Only an actual native CAS refusal is retryable. A malformed publication response cannot
    // turn a write of unknown identity into a successful no-op on a later iteration.
    const result = z
      .object({
        commit: z.object({ sha: Sha }),
        content: z.object({ sha: Sha }),
      })
      .parse(response);
    if (result.content.sha !== evidence.afterBlob)
      routingError("published blob mismatch");
    return publicationResultSchema.parse({
      ...common,
      status: "git_published",
      deploySha: result.commit.sha,
      receipt: rollback ? null : result.commit.sha,
    });
  }
  return routingError("routing CAS exhausted");
}
