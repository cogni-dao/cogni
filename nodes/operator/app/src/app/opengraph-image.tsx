// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/opengraph-image`
 * Purpose: Generated social + gallery thumbnail rendered from THIS node's
 *   repo-spec identity (name + hook + brand.color). One image serves both the
 *   `og:image` link preview and the operator gallery card — always current,
 *   no committed binaries, no CDN (the node's own Next server renders it).
 * Scope: Single default export (Next metadata file convention) → /opengraph-image.
 * Invariants:
 *   - IDENTITY_IS_REPO_SPEC_PROJECTION: every literal derives from `intent.*`
 *     via repoSpec.server; the node name/hook/color are never hardcoded here.
 * Side-effects: reads repo-spec from disk (node runtime).
 * Links: nodes/operator/.cogni/repo-spec.yaml, src/app/.well-known/agent.json/route.ts
 * @public
 */

// satori (the next/og renderer) supports ONLY inline styles — no className /
// CSS files — so the no-inline-styles rule cannot apply to this image route.
/* eslint-disable no-inline-styles/no-inline-styles */

import { ImageResponse } from "next/og";
import {
  getNodeBrandColor,
  getNodeHook,
  getNodeName,
} from "@/shared/config/repoSpec.server";

export const runtime = "nodejs";
// Render at request time, never at build. The image is drawn from repo-spec,
// which resolves via serverEnv() (full runtime env) — absent during the build
// prerender. force-dynamic defers execution to the deployed pod, mirroring how
// the .well-known/agent.json route stays dynamic by reading request headers.
export const dynamic = "force-dynamic";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Cogni node identity card";

// Monogram tint fallback when a node has not yet declared `intent.brand.color`.
const FALLBACK_COLOR = "#6366f1";

/** TitleCase a node slug for display (`node-template` → `Node Template`). */
function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function OpengraphImage(): ImageResponse {
  const name = titleCase(getNodeName());
  const hook = getNodeHook();
  const color = getNodeBrandColor() ?? FALLBACK_COLOR;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#09090b",
        backgroundImage: `radial-gradient(1000px circle at 100% 0%, ${color}33, transparent 55%)`,
        borderLeft: `16px solid ${color}`,
        padding: "84px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
        <div
          style={{
            width: "30px",
            height: "30px",
            borderRadius: "9999px",
            background: color,
          }}
        />
        <div
          style={{
            color: "#a1a1aa",
            fontSize: "30px",
            fontWeight: 600,
            letterSpacing: "8px",
          }}
        >
          COGNI
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <div
          style={{
            color: "#fafafa",
            fontSize: "100px",
            fontWeight: 700,
            lineHeight: 1.04,
          }}
        >
          {name}
        </div>
        {hook ? (
          <div style={{ color, fontSize: "46px", fontWeight: 500 }}>{hook}</div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
          color: "#71717a",
          fontSize: "28px",
        }}
      >
        <span>cognidao.org</span>
      </div>
    </div>,
    size
  );
}
