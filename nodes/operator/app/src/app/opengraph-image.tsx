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

import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import { resolveBrandIcon } from "@/shared/brand/brandIcons";
import {
  getNodeBrandColor,
  getNodeBrandIcon,
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

/**
 * `brand.icon` can be a hosted image asset (the node's real logo, e.g. `/TransparentBrainOnly.png`).
 * satori has no network/fs loader, so inline the bytes as a data URI read from the node's own `public/`.
 * Returns null (→ Lucide fallback) when the value isn't a local path or the file can't be found.
 */
function brandImageDataUri(icon: string | null): string | null {
  if (!icon || !icon.startsWith("/")) return null;
  const rel = icon.replace(/^\/+/, "");
  const candidates = [
    path.join(process.cwd(), "app", "public", rel),
    path.join(process.cwd(), "public", rel),
    path.join(process.cwd(), "nodes", "operator", "app", "public", rel),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext}`;
      return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export default function OpengraphImage(): ImageResponse {
  const name = titleCase(getNodeName());
  const hook = getNodeHook();
  const color = getNodeBrandColor() ?? FALLBACK_COLOR;
  // brand.icon is a hosted logo image (rendered from the node's own public/) OR a Lucide NAME.
  const rawIcon = getNodeBrandIcon();
  const iconImageUri = brandImageDataUri(rawIcon);
  const BrandIcon = iconImageUri ? null : resolveBrandIcon(rawIcon);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#09090b",
        backgroundImage: `radial-gradient(1100px circle at 50% 16%, ${color}26, transparent 60%)`,
        borderLeft: `16px solid ${color}`,
        padding: "72px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "9999px",
            background: color,
          }}
        />
        <div
          style={{
            color: "#a1a1aa",
            fontSize: "28px",
            fontWeight: 600,
            letterSpacing: "8px",
          }}
        >
          COGNI
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", color, marginBottom: "20px" }}>
          {iconImageUri ? (
            <img
              src={iconImageUri}
              width={200}
              height={200}
              style={{ objectFit: "contain" }}
              alt=""
            />
          ) : BrandIcon ? (
            <BrandIcon width={200} height={200} strokeWidth={1.5} />
          ) : null}
        </div>
        <div
          style={{
            color: "#fafafa",
            fontSize: "92px",
            fontWeight: 700,
            lineHeight: 1.0,
          }}
        >
          {name}
        </div>
        {hook ? (
          <div style={{ color, fontSize: "42px", fontWeight: 500 }}>{hook}</div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
          color: "#71717a",
          fontSize: "26px",
        }}
      >
        <span>cognidao.org</span>
      </div>
    </div>,
    size
  );
}
