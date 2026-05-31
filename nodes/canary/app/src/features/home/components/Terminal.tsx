// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/Terminal`
 * Purpose: Animated terminal component displaying progressive installation steps with copy functionality.
 * Scope: Feature component for home page showcasing CLI installation process; manages animation state. Does NOT handle actual CLI execution.
 * Invariants: Steps animate sequentially; copy button shows feedback; maintains accessibility.
 * Side-effects: time (animation timers), IO (clipboard write)
 * Notes: Composes TerminalFrame with feature-specific state and animation logic.
 * Links: src/components/kit/data-display/TerminalFrame.tsx
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Prompt, Reveal, TerminalFrame } from "@/components";

export function Terminal(): ReactElement {
  const steps = [
    "git clone https://github.com/Cogni-DAO/cogni",
    "cd cogni-template",
    "pnpm setup local",
    "pnpm dev:stack 🎉",
  ];
  const [currentStep, setCurrentStep] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (currentStep >= steps.length - 1) return;

    const timer = setTimeout(() => {
      setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1));
    }, 500);
    return () => clearTimeout(timer);
  }, [currentStep]);

  const onCopy = (): void => {
    navigator.clipboard.writeText(steps.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <TerminalFrame onCopy={onCopy} copied={copied}>
      {steps.map((step, index) => (
        <Reveal
          key={step}
          state={index > currentStep ? "hidden" : "visible"}
          duration="normal"
          delay="none"
        >
          <Prompt tone="success">$</Prompt> {step}
        </Reveal>
      ))}
    </TerminalFrame>
  );
}
