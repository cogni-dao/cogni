// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/built-image`
 * Purpose: Resolve the image node CI built at a source sha to its immutable, digest-pinned reference,
 *   so a workload manifest's image `.` lowers to `repo@sha256:<digest>` (story.5127).
 * Scope: Interface and one error class. No IO.
 * Invariants:
 *   - DIGEST_PINNED: a resolved reference is always `<imageRepository>@sha256:<64 hex>`; a mutable tag
 *     is never returned.
 *   - NOT_FOUND_IS_NULL: an absent (or not publicly readable) image is `null`, never a thrown error;
 *     only a registry failure throws `BuiltImageRegistryError`.
 * Side-effects: none
 * Links: adapters/server/oci/ghcr-built-image.adapter.ts, app/api/v1/deploy/workloads/route.ts
 * @public
 */

export interface BuiltImageResolverPort {
  /** Read the existing CI publication by accepted digest when supplied; never assemble image tags. */
  resolveArtifactBundle?(input: {
    readonly imageRepository: string;
    readonly sourceSha: string;
    readonly acceptedDigest?: string;
  }): Promise<{ readonly digestRef: string; readonly bundle: unknown } | null>;
  /**
   * Resolve `${imageRepository}:sha-${sourceSha}` to `${imageRepository}@sha256:<digest>`.
   * Returns null when the image does not exist (or is not publicly readable).
   */
  resolveBuiltImage(input: {
    /** `ghcr.io/<owner>/<image>`. */
    readonly imageRepository: string;
    /** The 40-hex source commit the image was built from. */
    readonly sourceSha: string;
  }): Promise<string | null>;
}

/** The registry failed (network, 5xx, malformed answer). The caller maps it to a retryable 502. */
export class BuiltImageRegistryError extends Error {
  constructor(
    message: string,
    readonly invalid = false
  ) {
    super(message);
    this.name = "BuiltImageRegistryError";
  }
}
