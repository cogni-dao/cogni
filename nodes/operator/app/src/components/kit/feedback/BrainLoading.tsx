// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@components/kit/feedback/BrainLoading`
 * Purpose: One wordless loading indicator with an anchored brain and a vector activity arc.
 * Scope: Presentational, server-renderable feedback; no hooks or animation runtime.
 * Invariants: Fills available space; image dimensions are reserved; reduced motion is respected.
 * Side-effects: none
 * @public
 */

import Image from "next/image";

import {
  brainLoading,
  brainLoadingGraphic,
  brainLoadingMark,
  brainLoadingOrbit,
  brainLoadingSpectrum,
  brainLoadingTrack,
} from "@/styles/ui";

export function BrainLoading() {
  return (
    <div role="status" aria-label="Loading" className={brainLoading()}>
      <div className={brainLoadingGraphic()}>
        <svg
          viewBox="0 0 80 80"
          fill="none"
          aria-hidden="true"
          focusable="false"
          className={brainLoadingTrack()}
        >
          <circle
            cx="40"
            cy="40"
            r="36"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity="0.12"
          />
        </svg>
        <span aria-hidden="true" className={brainLoadingOrbit()}>
          <span className={brainLoadingSpectrum()} />
        </span>
        <Image
          src="/brain-loading.webp"
          alt=""
          width={48}
          height={48}
          unoptimized
          loading="eager"
          className={brainLoadingMark()}
        />
      </div>
    </div>
  );
}
