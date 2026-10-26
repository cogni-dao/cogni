// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-physical-postimage`
 * Purpose: Qualify fixed physical-recovery postimages from owned private preimage bytes.
 * Scope: Parse and compare only; no config-edit API or provider mutation.
 * Invariants: Source/app sleep holds; only target capacity and owned consumer values move.
 * Side-effects: none
 * Links: database-cell-applied-managed.adapter.ts, subtask.5023
 * @internal
 */
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { DatabaseCellPhysicalRecoveryEvidenceSchema } from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";
import { evidenceSha256 } from "./database-cell-applied-artifacts";

const sdl = z.string().min(1).max(100000);
export const PhysicalRecoveryArtifactSchema = z
  .object({
    evidence: DatabaseCellPhysicalRecoveryEvidenceSchema,
    // These private bytes stay inside bootstrap-owned custody. Facts/HTTP contain hashes only.
    definitions: z
      .object({
        sourceOriginal: sdl,
        sourceHeld: sdl,
        targetCold: sdl,
        targetNormal: sdl,
        appOriginal: sdl,
        appHeld: sdl,
      })
      .strict(),
  })
  .strict();
export type PhysicalRecoveryArtifact = z.infer<
  typeof PhysicalRecoveryArtifactSchema
>;
const Service = z
  .object({
    image: z.string(),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
    params: z
      .object({
        storage: z.record(
          z.string(),
          z.object({ mount: z.string(), readOnly: z.boolean() }).passthrough()
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const Definition = z
  .object({ services: z.record(z.string(), Service) })
  .passthrough();
const decode = (value: string) => Definition.parse(parse(value));
function onlyService(definition: z.infer<typeof Definition>, name: string) {
  const service = definition.services[name];
  if (!service || Object.keys(definition.services).length !== 1)
    throw new Error("physical_postimage_service_ambiguous");
  return service;
}
const same = (actual: unknown, expected: unknown) => {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error("physical_postimage_unreviewed_delta");
};
export function qualifyPhysicalPostimages(input: {
  artifact: PhysicalRecoveryArtifact;
  custody: DatabaseCellAppliedCustody;
  primaryServiceName: string;
  appServiceName: string;
}) {
  const { evidence: e, definitions: d } = input.artifact;
  if (
    evidenceSha256(d.sourceHeld) !== e.source.heldSdlHash ||
    evidenceSha256(d.targetCold) !== e.target.preimageSdlHash ||
    evidenceSha256(d.targetNormal) !== e.target.normalSdlHash ||
    evidenceSha256(d.appOriginal) !== e.app.preimageSdlHash ||
    evidenceSha256(d.appHeld) !== e.app.heldSdlHash
  )
    throw new Error("physical_postimage_private_bytes_digest_mismatch");
  const original = decode(d.sourceOriginal),
    held = decode(d.sourceHeld),
    cold = decode(d.targetCold),
    normal = decode(d.targetNormal);
  const source = onlyService(original, input.primaryServiceName),
    sourceHeld = onlyService(held, input.primaryServiceName),
    targetCold = onlyService(cold, input.primaryServiceName);
  const heldExpected = structuredClone(original),
    heldService = onlyService(heldExpected, input.primaryServiceName);
  heldService.command = ["sleep"];
  heldService.args = ["infinity"];
  const mounts = heldService.params?.storage;
  if (
    !mounts ||
    Object.values(mounts).filter(
      (mount) => mount.mount === "/var/lib/postgresql/data"
    ).length !== 1
  )
    throw new Error("physical_postimage_source_volume_missing");
  for (const mount of Object.values(mounts))
    if (mount.mount === "/var/lib/postgresql/data") mount.readOnly = true;
  same(held, heldExpected);
  if (
    source.image !== targetCold.image ||
    sourceHeld.image !== source.image ||
    source.image.split("@")[1] !==
      input.custody.manualProvenance.postgresImageDigest ||
    JSON.stringify(targetCold.command) !== JSON.stringify(["sleep"]) ||
    JSON.stringify(targetCold.args) !== JSON.stringify(["infinity"])
  )
    throw new Error("physical_postimage_target_image_or_cold_hold_mismatch");
  const normalExpected = structuredClone(cold);
  normalExpected.services[input.primaryServiceName] = {
    ...source,
    params: targetCold.params,
    expose: targetCold.expose,
  };
  same(normal, normalExpected);
  const script = (service: z.infer<typeof Service>) =>
    JSON.stringify([service.command ?? [], service.args ?? []]);
  if (
    evidenceSha256(script(source)) !== e.copy.originalStartupSha256 ||
    evidenceSha256(script(onlyService(normal, input.primaryServiceName))) !==
      e.copy.targetStartupSha256
  )
    throw new Error("physical_postimage_original_startup_mismatch");
  const appOriginal = decode(d.appOriginal),
    appHeld = decode(d.appHeld),
    appExpected = structuredClone(appOriginal);
  const appService = appExpected.services[input.appServiceName];
  if (!appService) throw new Error("physical_postimage_app_service_missing");
  // Every declared service must be held, including workers/sidecars that might write.
  for (const service of Object.values(appExpected.services)) {
    service.command = ["sleep"];
    service.args = ["infinity"];
  }
  const values = new Map(
    (appService.env ?? []).map((value) => {
      const i = value.indexOf("=");
      return [value.slice(0, i), value.slice(i + 1)];
    })
  );
  for (const [key, value] of [
    ["DATABASE_URL", input.custody.app.dsn],
    ["DATABASE_SERVICE_URL", input.custody.service.dsn],
    ...(input.custody.tls.kind === "private-ca"
      ? [["DATABASE_SSL_CA_CERT", input.custody.tls.caCertificate]]
      : []),
    ...(input.custody.migration.kind === "dedicated-migration-url" &&
    values.has("DATABASE_MIGRATION_URL")
      ? [["DATABASE_MIGRATION_URL", input.custody.migration.dsn]]
      : []),
  ]) {
    if (!key || value === undefined)
      throw new Error("physical_postimage_consumer_missing");
    values.set(key, value);
  }
  appService.env = [...values.entries()].map(
    ([key, value]) => `${key}=${value}`
  );
  // Env order has no runtime meaning; compare exact values without permitting duplicate names.
  for (const definition of [appHeld, appExpected])
    for (const service of Object.values(definition.services)) {
      if (service.env) {
        if (
          new Set(
            service.env.map((value) => value.slice(0, value.indexOf("=")))
          ).size !== service.env.length
        )
          throw new Error("physical_postimage_duplicate_env");
        service.env.sort();
      }
    }
  same(appHeld, appExpected);
}
