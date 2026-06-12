// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/StepSection`
 * Purpose: Borderless step body — a heading + content block rendered inside the single WizardFrame
 *   card (steps no longer carry their own SectionCard, which produced nested card-in-card chrome).
 * Scope: Presentational. Token-only styling.
 * Side-effects: none
 * Links: ./WizardFrame.tsx
 * @public
 */

import type { ReactElement, ReactNode } from "react";

interface Props {
  readonly title: string;
  readonly children: ReactNode;
}

export function StepSection({ title, children }: Props): ReactElement {
  return (
    <section className="space-y-5">
      <h3 className="font-semibold text-foreground text-lg">{title}</h3>
      {children}
    </section>
  );
}
