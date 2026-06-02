// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/typography/FlipWords`
 * Purpose: Kit wrapper for animated flip words with staggered letter animations.
 * Scope: Renders animated flip words. Does not handle text content.
 * Invariants: Uses motion/react primitives; no className prop overrides; styled via CVA.
 * Side-effects: none
 * Notes: Wrapper for FlipWords with kit-specific styling and animation timing.
 * Links: src/components/kit/typography/HeroActionWords.tsx
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { AnimatePresence, motion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

export const FlipWords = ({
  words,
  duration = 3000,
  className,
}: {
  words: string[];
  duration?: number;
  className?: string;
}): React.JSX.Element => {
  const [currentWord, setCurrentWord] = useState(words[0] ?? "");
  const [isAnimating, setIsAnimating] = useState<boolean>(false);

  // thanks for the fix Julian - https://github.com/Julian-AT
  const startAnimation = useCallback(() => {
    const word = words[words.indexOf(currentWord) + 1] ?? words[0] ?? "";
    setCurrentWord(word);
    setIsAnimating(true);
  }, [currentWord, words]);

  useEffect(() => {
    if (!isAnimating)
      setTimeout(() => {
        startAnimation();
      }, duration);
  }, [isAnimating, duration, startAnimation]);

  return (
    <AnimatePresence
      onExitComplete={() => {
        setIsAnimating(false);
      }}
    >
      <motion.div
        initial={{
          opacity: 0,
          y: 10,
        }}
        animate={{
          opacity: 1,
          y: 0,
        }}
        transition={{
          type: "spring",
          stiffness: 100,
          damping: 10,
        }}
        exit={{
          opacity: 0,
          y: -40,
          x: 40,
          filter: "blur(8px)",
          scale: 2,
          position: "absolute",
        }}
        className={cn(
          "relative z-10 inline-block px-[var(--spacing-sm)] text-foreground",
          className
        )}
        key={currentWord}
      >
        {/* edit suggested by Sajal: https://x.com/DewanganSajal */}
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
};
