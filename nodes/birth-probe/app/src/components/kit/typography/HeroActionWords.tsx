// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/typography/HeroActionWords`
 * Purpose: Kit wrapper for animated flip words in hero sections.
 * Scope: Renders animated action words. Does not handle text content.
 * Invariants: Uses FlipWords primitive; no className prop; styled via CVA.
 * Side-effects: none
 * Notes: Wrapper for FlipWords with hero-specific styling.
 * Links: src/components/vendor/ui-primitives/shadcn/flip-words.tsx
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { AnimatePresence, motion } from "motion/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { codeToken } from "@/styles/ui";

interface HeroActionWordsProps {
  actions: string[];
  /**
   * Time each action stays visible.
   * Default ~1s to match hero rhythm.
   */
  durationMs?: number;
  /**
   * Syntax token type for styling.
   * Default variable (green).
   */
  kind?:
    | "keyword"
    | "operator"
    | "variable"
    | "punctuation"
    | "property"
    | "delimiter"
    | "parenthesis"
    | "identifier"
    | "accent";
}

export function HeroActionWords({
  actions,
  durationMs = 1000,
  kind = "variable",
}: HeroActionWordsProps): ReactElement {
  const [currentWord, setCurrentWord] = useState(actions[0] ?? "");
  const [isAnimating, setIsAnimating] = useState(false);

  const rotateWord = useCallback(() => {
    const index = actions.indexOf(currentWord);
    const nextWord = actions[index + 1] ?? actions[0] ?? "";
    setCurrentWord(nextWord);
    setIsAnimating(true);
  }, [actions, currentWord]);

  useEffect(() => {
    if (actions.length <= 1) return;
    if (!isAnimating) {
      const timeout = setTimeout(() => rotateWord(), durationMs);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [actions.length, durationMs, isAnimating, rotateWord]);

  return (
    <AnimatePresence
      onExitComplete={() => {
        setIsAnimating(false);
      }}
    >
      <motion.div
        key={currentWord}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{
          opacity: 0,
          y: -40,
          x: 40,
          filter: "blur(8px)",
          scale: 2,
          position: "absolute",
        }}
        transition={{
          type: "spring",
          stiffness: 120,
          damping: 14,
        }}
        className={cn(
          "relative inline-flex px-[var(--spacing-sm)]",
          codeToken({ kind, spacingRight: "none" })
        )}
      >
        {(currentWord ?? "").split(" ").map((word, wordIndex) => (
          <motion.span
            key={`${wordIndex}-${word}`}
            initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{
              delay: wordIndex * 0.3,
              duration: 0.3,
            }}
            className="inline-block whitespace-nowrap"
          >
            {word.split("").map((letter, letterIndex) => (
              <motion.span
                key={`${wordIndex}-${letterIndex}-${letter}`}
                initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{
                  delay: wordIndex * 0.3 + letterIndex * 0.05,
                  duration: 0.2,
                }}
                className="inline-block"
              >
                {letter}
              </motion.span>
            ))}
            <span className="inline-block">&nbsp;</span>
          </motion.span>
        ))}
      </motion.div>
    </AnimatePresence>
  );
}
