// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Strict value-free comparative wire contract. Never an accepted-release certificate. */
import { z } from "zod";

export const COMPUTE_PROOF_PATH = "/v1/compute/release-proof";
export const COMPUTE_PROOF_BODY_BYTES = 65_536;
const identifier = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const key = z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const image = z.string().max(256).regex(/^[a-z0-9][a-z0-9.:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/);
const host = z.string().min(1).max(128).regex(/^(?=.{1,128}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
export const ProofServiceSchema = z.object({
  name: identifier, artifact: identifier,
  runtimeProfile: z.enum(["cogni-node-app-v1", "image-default"]),
  commandTemplate: z.enum(["image-default", "cogni-node-app-v1+database-ca-v1"]),
  secretRefs: z.array(z.object({key}).strict()).max(64).refine(v => unique(v.map(x=>x.key))),
  bindings: z.array(z.object({key, service: identifier}).strict()).max(32).refine(v=>unique(v.map(x=>x.key))),
  port: z.number().int().min(1).max(65535), visibility: z.enum(["public", "private"]),
  bindHost: z.literal("0.0.0.0"), cpuUnits: z.number().int().min(1).max(100000),
  memoryMi: z.number().int().min(1).max(1048576), storageMi: z.number().int().min(0).max(10485760),
}).strict();
export const ProofWorkloadSchema = z.object({
  instance: identifier.nullable(), kind: z.enum(["XComputeWorkload", "ComputeWorkload"]),
  publicHost: host.nullable(), leaseGeneration: z.number().int().min(0),
  artifacts: z.array(z.object({name: identifier, image}).strict()).min(1).max(32).refine(v=>unique(v.map(x=>x.name))),
  services: z.array(ProofServiceSchema).min(1).max(32).refine(v=>unique(v.map(x=>x.name))),
}).strict().superRefine((v,ctx)=>{
 const artifacts = new Set(v.artifacts.map(x=>x.name));
 const services = new Set(v.services.map(x=>x.name));
 if(v.services.some(s=>!artifacts.has(s.artifact) || s.bindings.some(b=>!services.has(b.service))) || v.artifacts.some(a=>!v.services.some(s=>s.artifact===a.name))) ctx.addIssue({code:"custom",message:"unbound inventory"});
});
export const ComputeProofRequestSchema = z.object({
  version: z.literal(1), nonce: z.string().regex(/^[0-9a-f]{64}$/),
  expected: z.object({
    nodeId: z.string().uuid(), repository: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    environment: z.enum(["candidate-a", "preview", "production"]), sourceSha: sha, deploySha: sha,
    bundleRef: image, workloads: z.array(ProofWorkloadSchema).min(1).max(16).refine(v=>unique(v.map(x=>x.instance??""))),
  }).strict(),
}).strict().superRefine((v,ctx)=>{
 if(v.expected.workloads.reduce((n,w)=>n+w.services.length,0)>32 || v.expected.workloads.reduce((n,w)=>n+w.artifacts.length,0)>32) ctx.addIssue({code:"custom",message:"inventory limit"});
});
const verdict = z.enum(["verified", "running", "failed", "unavailable"]);
export const ComputeProofResponseSchema = z.object({
 version:z.literal(1), hash:z.string().regex(/^[0-9a-f]{64}$/), nonce:z.string().regex(/^[0-9a-f]{64}$/),
 tuple: z.object({nodeId:z.string().uuid(),repository:z.string(),environment:z.string(),sourceSha:sha,deploySha:sha,bundleRef:image}).strict(),
 observedAt:z.string().datetime(),
 dimensions:z.array(z.object({workload:identifier, native:verdict, migration:verdict, provider:verdict,
 code:z.enum(["verified","absent","ownership","wrong_source","stale_bundle","actuator_lag","unsupported_command","migration_running","migration_failed","migration_unavailable","provider_unavailable","unavailable"])}).strict()).max(16),
}).strict();
export type ComputeProofRequest = z.infer<typeof ComputeProofRequestSchema>;
export type ComputeProofResponse = z.infer<typeof ComputeProofResponseSchema>;
export type ProofService = z.infer<typeof ProofServiceSchema>;
export type ProofWorkload = z.infer<typeof ProofWorkloadSchema>;
