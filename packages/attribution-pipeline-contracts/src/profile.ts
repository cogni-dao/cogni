// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/profile`
 * Purpose: PipelineProfile type, registry, and resolution.
 * Scope: Types and pure functions. Does not perform I/O or hold state.
 * Invariants:
 * - PROFILE_IS_DATA: profiles are plain readonly objects — no classes, no methods, no I/O.
 * - PROFILE_IMMUTABLE_PUBLISH_NEW: profiles are semver'd and never mutated after publication.
 * - PROFILE_SELECTS_ENRICHERS: enricherRefs is sole authority for which enrichers run.
 * - PROFILE_SELECTS_ALLOCATOR: allocatorRef is the sole authority for which allocator runs.
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

/**
 * A single enricher reference within a profile, with optional dependency declarations.
 */
export interface EnricherRef {
  /** Identifies this enricher (e.g., "cogni.echo.v0"). */
  readonly enricherRef: string;

  /**
   * Evaluation refs that must exist before this enricher runs.
   * Dependencies are evaluation outputs, not enricher identities.
   * Empty array = no dependencies, can run first.
   */
  readonly dependsOnEvaluations: readonly string[];
}

/**
 * A pipeline profile is a plain readonly object selecting enrichers and allocator.
 * Keyed by attribution_pipeline from repo-spec.yaml.
 * Profiles are semver'd and NEVER mutated — publish a new version instead.
 */
export interface PipelineProfile {
  /** Semver'd profile ID (e.g., "cogni-v0.0"). Immutable once published. */
  readonly profileId: string;

  /** Human-readable label for logging/UI. */
  readonly label: string;

  /**
   * Ordered list of enricher refs to run.
   * No core/plugin split — all enrichers listed here.
   */
  readonly enricherRefs: readonly EnricherRef[];

  /** The allocation algorithm ref (pinned on epoch at closeIngestion). */
  readonly allocatorRef: string;

  /**
   * Epoch kind discriminator for the epochs table.
   * Default: "activity". Quarterly review: "quarterly_review".
   */
  readonly epochKind: string;

  /**
   * Default weight config for this profile's allocator.
   * Keyed by "{source}:{eventType}" (e.g., "github:pr_merged").
   * Pinned on epoch creation via ensureEpochForWindow.
   */
  readonly defaultWeightConfig?: Readonly<Record<string, number>>;

  /**
   * Selection policy ref for this profile.
   * Determines which receipts are included in the epoch (e.g., promotion-based, include-all).
   * Dispatched via SelectionPolicyRegistry during materializeSelection.
   */
  readonly selectionPolicyRef: string;
}

/** Registry mapping profileId → PipelineProfile. */
export type ProfileRegistry = ReadonlyMap<string, PipelineProfile>;

/**
 * Resolve a profile by attribution_pipeline key, or throw.
 */
export function resolveProfile(
  registry: ProfileRegistry,
  attributionPipeline: string
): PipelineProfile {
  const profile = registry.get(attributionPipeline);
  if (!profile) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown attribution_pipeline: "${attributionPipeline}". Available profiles: [${available}]`
    );
  }
  return profile;
}
