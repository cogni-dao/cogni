// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/sections/FeaturesGrid`
 * Purpose: Kit component for feature showcase sections with three-column grid layout.
 * Scope: Provides styled features grid container. Does not handle feature content.
 * Invariants: Uses layout primitives; responsive grid; consistent spacing.
 * Side-effects: none
 * Notes: Encapsulates section/container/grid styling for feature showcase patterns.
 * Links: src/styles/ui/layout.ts
 * @public
 */

import { cva } from "class-variance-authority";
import type { ReactElement, ReactNode } from "react";

import {
  container,
  grid,
  heading,
  iconBox,
  paragraph,
  section,
} from "@/styles/ui";

// Feature-specific layout styles (localized to this component)
const featureContent = cva("mt-[var(--spacing-lg)]");
const featureItem = cva("mt-[var(--spacing-2xl)] lg:mt-0");
const smallIcon = cva("h-[var(--size-icon-lg)] w-[var(--size-icon-lg)]");

interface FeatureItemProps {
  /**
   * Feature icon (SVG or Lucide component)
   */
  icon: ReactNode;
  /**
   * Feature title
   */
  title: string;
  /**
   * Feature description
   */
  description: string;
  /**
   * Whether this is the first item (no top margin)
   */
  isFirst?: boolean;
}

function FeatureGridItem({
  icon,
  title,
  description,
  isFirst = false,
}: FeatureItemProps): ReactElement {
  return (
    <div className={isFirst ? "" : featureItem()}>
      <div className={iconBox({ size: "lg" })}>
        {typeof icon === "object" && icon && "type" in icon ? (
          <icon.type className={smallIcon()} />
        ) : (
          icon
        )}
      </div>
      <div className={featureContent()}>
        <h2 className={heading({ level: "h4", tone: "default" })}>{title}</h2>
        <p className={paragraph({ spacing: "sm" })}>{description}</p>
      </div>
    </div>
  );
}

interface FeaturesGridProps {
  /**
   * Array of feature items
   */
  features: {
    id: string;
    icon: ReactNode;
    title: string;
    description: string;
  }[];
  /**
   * Background surface variant
   */
  surface?: "default" | "muted";
}

export function FeaturesGrid({
  features,
  surface = "default",
}: FeaturesGridProps): ReactElement {
  return (
    <section className={section({ surface })}>
      <div className={container({ size: "lg", spacing: "lg" })}>
        <div className={grid({ cols: "3", gap: "md" })}>
          {features.map((feature, index) => (
            <FeatureGridItem
              key={feature.id}
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
              isFirst={index === 0}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
