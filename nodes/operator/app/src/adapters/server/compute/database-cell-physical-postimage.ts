// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-physical-postimage`
 * Purpose: Qualify fixed physical-recovery postimages from owned private preimage bytes.
 * Scope: Parse and compare only; no config-edit API or provider mutation.
 * Invariants: Originals match ledger or independent native custody; source RO and exact guarded target delta.
 * Side-effects: none
 * Links: database-cell-applied-managed.adapter.ts, subtask.5023
 * @internal
 */
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import {
  AppliedDatabaseCellReceiptSchema,
  DatabaseCellPhysicalRecoveryEvidenceSchema,
  physicalSourceBindingSha256,
} from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";
import {
  canonicalEvidenceJson,
  evidenceSha256,
} from "./database-cell-applied-artifacts";

const sdl = z.string().min(1).max(100000);
export const PhysicalRecoveryArtifactSchema = z
  .object({
    evidence: DatabaseCellPhysicalRecoveryEvidenceSchema,
    // A reserved-bank anchor authenticates this full pre-hold capture independently
    // from the submitted packet. Missing historical canonical bytes remain unknown.
    nativeCapture: z
      .object({
        sourceCapturedAt: z.string().datetime({ offset: true }),
        originalStoredSdl: sdl,
        originalAppStoredSdl: sdl,
        originalProviderManifest: z
          .array(
            z
              .object({
                services: z.array(z.record(z.string(), z.unknown())).length(1),
              })
              .passthrough()
          )
          .length(1),
        originalAppProviderManifest: z
          .array(
            z
              .object({
                services: z.array(z.record(z.string(), z.unknown())).min(1),
              })
              .passthrough()
          )
          .length(1),
        sourceBinding: AppliedDatabaseCellReceiptSchema,
        historicalCanonicalBytesRecovered: z.literal(false),
      })
      .strict()
      .optional(),
    startupGuard: sdl.optional(),
    ledgerPreimages: z.object({ targetCold: sdl }).strict(),
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
    env: z
      .array(z.string().refine((value) => value.indexOf("=") > 0))
      .optional(),
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
  ledgerHashes: {
    readonly source: string;
    readonly target: string;
    readonly app: string;
  };
}) {
  const {
    evidence: e,
    definitions: d,
    ledgerPreimages: l,
    nativeCapture: capture,
  } = input.artifact;
  const anchor = input.custody.physicalRecoverySource;
  if (!anchor)
    throw new Error("physical_native_capture_independent_custody_missing");
  {
    if (
      !capture ||
      !input.artifact.startupGuard ||
      evidenceSha256(
        canonicalEvidenceJson(JSON.parse(JSON.stringify(capture)))
      ) !== anchor.captureSha256 ||
      evidenceSha256(input.artifact.startupGuard) !==
        anchor.startupGuardSha256 ||
      physicalSourceBindingSha256(capture.sourceBinding) !==
        anchor.sourceBindingSha256 ||
      capture.sourceBinding.binding.receiptId !== anchor.sourceReceiptId ||
      capture.sourceBinding.binding.receiptId !== e.source.receiptId ||
      capture.sourceBinding.binding.cogniKey !== e.source.cogniKey ||
      capture.sourceBinding.binding.dseq !== e.source.dseq ||
      capture.sourceBinding.binding.providerAccount !==
        e.source.providerAccount ||
      capture.sourceBinding.binding.nodeId !== input.custody.nodeId ||
      capture.sourceBinding.binding.nodeSlug !== input.custody.nodeSlug ||
      capture.sourceBinding.binding.databaseName !==
        input.custody.databaseName ||
      capture.sourceBinding.binding.appRole !== input.custody.appRole ||
      capture.sourceBinding.binding.serviceRole !== input.custody.serviceRole ||
      capture.sourceBinding.binding.systemIdentifier !==
        e.source.systemIdentifier ||
      !capture.sourceBinding.registration?.readmissionReceiptId ||
      capture.sourceBinding.binding.nativeControl !== undefined ||
      Date.parse(capture.sourceCapturedAt) > Date.parse(e.copy.startedAt)
    )
      throw new Error("physical_native_capture_independent_custody_mismatch");
    const captured = capture.originalProviderManifest[0]?.services[0];
    const source = onlyService(
      decode(d.sourceOriginal),
      input.primaryServiceName
    );
    if (!captured) throw new Error("physical_native_capture_source_missing");
    same(
      [source.image, source.command, source.args, source.env],
      [captured.image, captured.command, captured.args, captured.env]
    );
    const params = z
      .object({ storage: z.unknown() })
      .passthrough()
      .parse(captured.params);
    let storage = params.storage;
    if (Array.isArray(storage)) {
      const entries = storage.map((value) => {
        const { name, ...mount } = z
          .object({ name: z.string() })
          .passthrough()
          .parse(value);
        return [name, mount] as const;
      });
      if (new Set(entries.map(([name]) => name)).size !== entries.length)
        throw new Error("physical_native_capture_duplicate_volume");
      storage = Object.fromEntries(entries);
    }
    same(source.params, { ...params, storage });
    const originalScript = source.args?.[0] ?? "";
    if (
      ["fsync", "synchronous_commit", "full_page_writes"].some(
        (name) =>
          !originalScript.includes(`-c ${name}=on`) ||
          originalScript.includes(`-c ${name}=off`)
      )
    )
      throw new Error("physical_original_durability_not_enabled");
    same(d.appOriginal, capture.originalAppStoredSdl);
    same(d.appHeld, d.appOriginal);
    const originalRegistration = capture.sourceBinding.registration;
    const observedConsumers = new Set<string>();
    for (const group of capture.originalAppProviderManifest)
      for (const service of group.services) {
        const env = z.array(z.string()).parse(service.env ?? []);
        for (const [key, expected] of [
          ["DATABASE_URL", originalRegistration.appDsnSha256],
          ["DATABASE_SERVICE_URL", originalRegistration.serviceDsnSha256],
          ["DATABASE_MIGRATION_URL", originalRegistration.migrationDsnSha256],
        ]) {
          const values = env.filter((v) => v.startsWith(`${key}=`));
          if (values.length && key) observedConsumers.add(key);
          if (
            values.length > 1 ||
            (values[0] &&
              evidenceSha256(values[0].slice((key?.length ?? 0) + 1)) !==
                expected)
          )
            throw new Error(
              "physical_legacy_app_consumer_not_fenced_on_source"
            );
        }
      }
    if (
      !observedConsumers.has("DATABASE_URL") ||
      !observedConsumers.has("DATABASE_SERVICE_URL")
    )
      throw new Error("physical_legacy_app_consumer_proof_missing");
  }
  if (
    evidenceSha256(l.targetCold) !== input.ledgerHashes.target ||
    e.source.originalAppliedSdlHash !== input.ledgerHashes.source ||
    e.target.originalAppliedSdlHash !== input.ledgerHashes.target ||
    e.app.originalAppliedSdlHash !== input.ledgerHashes.app
  )
    throw new Error("physical_postimage_independent_ledger_anchor_mismatch");
  same(decode(d.targetCold), decode(l.targetCold));
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
  {
    normalExpected.services[input.primaryServiceName] = {
      ...targetCold,
      command: source.command,
      args: source.args,
      env: source.env,
    };
    const service = onlyService(normalExpected, input.primaryServiceName);
    if (
      JSON.stringify(service.command) !== JSON.stringify(["/bin/sh", "-ec"]) ||
      service.args?.length !== 1
    )
      throw new Error("physical_legacy_original_startup_shape_refused");
    const originalScript = service.args?.[0];
    if (!input.artifact.startupGuard || originalScript === undefined)
      throw new Error("physical_legacy_guard_missing");
    service.args = [input.artifact.startupGuard + originalScript];
  }
  same(normal, normalExpected);
  const script = (service: z.infer<typeof Service>) => service.args?.[0] ?? "";
  if (
    evidenceSha256(script(source)) !== e.copy.originalStartupSha256 ||
    evidenceSha256(script(onlyService(normal, input.primaryServiceName))) !==
      e.copy.targetStartupSha256
  )
    throw new Error("physical_postimage_original_startup_mismatch");
}
