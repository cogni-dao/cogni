// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/native/image-content-identity`
 * Purpose: Compare saved/loaded image content across Docker inspect API versions.
 * Scope: Inspected image values only. Does not contact Docker or alter input values.
 * Invariants: Only documented omitted defaults are equivalent; every nondefault and unknown field survives.
 * Side-effects: none
 * Links: https://docs.docker.com/engine/deprecated/#empty-nil-fields-in-image-config-from-inspect-api,
 *   https://docs.docker.com/reference/api/engine/version-history/#v150-api-changes
 * @internal
 */

// API 1.50 removed these container-only fields from image Config. Older
// daemons synthesize their zero values. Retain any unexpected nonzero value.
const legacyDefaults = {
  Hostname: "",
  Domainname: "",
  AttachStdin: false,
  AttachStdout: false,
  AttachStderr: false,
  Tty: false,
  OpenStdin: false,
  StdinOnce: false,
  Image: "",
};

// Docker 29 omits empty/nil image fields. Normalize only the three forms
// encountered by this bridge; all other config fields remain exact.
const imageDefaults = { User: "", Cmd: null, OnBuild: null };

export function imageContentIdentity(image) {
  return {
    config: { ...legacyDefaults, ...imageDefaults, ...image.Config },
    rootFS: image.RootFS,
    os: image.Os,
    architecture: image.Architecture,
    variant: image.Variant ?? "",
  };
}
