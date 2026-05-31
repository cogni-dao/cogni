// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/GithubButton`
 * Purpose: Kit component for GitHub repository interaction buttons with animated star counts.
 * Scope: Renders GitHub buttons with star counts and animations. Does not handle GitHub API calls.
 * Invariants: Uses CVA variants; no className prop overrides; maintains accessibility.
 * Side-effects: none
 * Notes: Animated button component for GitHub repository interactions.
 * Links: src/components/kit/inputs/Button.tsx
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { Star } from "lucide-react";
import {
  motion,
  type SpringOptions,
  type UseInViewOptions,
  useInView,
} from "motion/react";
import type {
  ButtonHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const githubButtonVariants = cva(
  "relative inline-flex items-center justify-center whitespace-nowrap rounded-md border font-medium transition-transform duration-200 ease-out hover:scale-105 focus-visible:outline-none focus-visible:ring-[var(--ring-width-sm)] focus-visible:ring-ring focus-visible:ring-offset-[var(--ring-offset-w-sm)] disabled:pointer-events-none disabled:opacity-60 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        outline:
          "border-border bg-background text-accent-foreground hover:bg-accent hover:text-accent-foreground",
        inverse:
          "border-[var(--github-button-border-dark)] bg-[var(--github-button-bg-dark)] text-[var(--github-button-text-dark)] hover:bg-[var(--github-button-bg-dark-hover)] dark:border-[var(--github-button-border)] dark:bg-[var(--github-button-bg)] dark:text-[var(--github-button-text)] dark:hover:bg-[var(--github-button-bg-hover)]",
        theme:
          "border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default:
          "h-8.5 gap-2 gap-2 rounded-md px-3 text-[var(--text-sm)] leading-none [&_svg]:size-4",
        sm: "h-7 gap-1.5 gap-1.5 rounded-md px-2.5 text-[var(--text-xs)] leading-none [&_svg]:size-3.5",
        lg: "h-10 gap-2.5 gap-2.5 rounded-md px-4 text-[var(--text-sm)] leading-none [&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

interface GithubButtonPrimitiveProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof githubButtonVariants> {
  /** Whether to round stars */
  roundStars?: boolean;
  /** Whether to show Github icon */
  fixedWidth?: boolean;
  /** Initial number of stars */
  initialStars?: number;
  /** Class for stars */
  starsClass?: string;
  /** Target number of stars to animate to */
  targetStars?: number;
  /** Animation duration in seconds */
  animationDuration?: number;
  /** Animation delay in seconds */
  animationDelay?: number;
  /** Whether to start animation automatically */
  autoAnimate?: boolean;
  /** Callback when animation completes */
  onAnimationComplete?: () => void;
  /** Whether to show Github icon */
  showGithubIcon?: boolean;
  /** Whether to show star icon */
  showStarIcon?: boolean;
  /** Whether to show separator */
  separator?: boolean;
  /** Whether stars should be filled */
  filled?: boolean;
  /** Repository URL for actual Github integration */
  repoUrl?: string;
  /** Button text label */
  label?: string;
  /** Use in-view detection to trigger animation */
  useInViewTrigger?: boolean;
  /** In-view options */
  inViewOptions?: UseInViewOptions;
  /** Spring transition options */
  transition?: SpringOptions;
}

function GithubButtonPrimitive({
  initialStars = 0,
  targetStars = 0,
  starsClass = "",
  fixedWidth = true,
  animationDuration = 2,
  animationDelay = 0,
  autoAnimate = true,
  className,
  variant = "default",
  size = "default",
  showGithubIcon = true,
  showStarIcon = true,
  roundStars = false,
  separator = false,
  filled = false,
  repoUrl,
  onClick,
  label = "",
  useInViewTrigger = false,
  inViewOptions = { once: true },
  transition,
  ...props
}: GithubButtonPrimitiveProps): ReactElement {
  const [currentStars, setCurrentStars] = useState(initialStars);
  const [isAnimating, setIsAnimating] = useState(false);
  const [starProgress, setStarProgress] = useState(filled ? 100 : 0);
  const [hasAnimated, setHasAnimated] = useState(false);

  // Format number with units
  const formatNumber = (num: number): string => {
    const units = ["k", "M", "B", "T"];

    if (roundStars && num >= 1000) {
      let unitIndex = -1;
      let value = num;

      while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
      }

      // Format to 1 decimal place if needed, otherwise show whole number
      const formatted = value % 1 === 0 ? value.toString() : value.toFixed(1);
      return `${formatted}${units[unitIndex]}`;
    }

    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  // Start animation
  const startAnimation = useCallback(() => {
    if (isAnimating || hasAnimated) return;

    setIsAnimating(true);
    const startTime = Date.now();
    const startValue = 0;
    const endValue = targetStars;
    const duration = animationDuration * 1000;

    const animate = (): void => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function for smooth animation
      const easeOutQuart = 1 - (1 - progress) ** 4;

      // Update star count from 0 to target with more frequent updates
      const newStars = Math.round(
        startValue + (endValue - startValue) * easeOutQuart
      );
      setCurrentStars(newStars);

      // Update star fill progress (0 to 100)
      setStarProgress(progress * 100);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setCurrentStars(endValue);
        setStarProgress(100);
        setIsAnimating(false);
        setHasAnimated(true);
      }
    };

    setTimeout(() => {
      requestAnimationFrame(animate);
    }, animationDelay * 1000);
  }, [
    isAnimating,
    hasAnimated,
    targetStars,
    animationDuration,
    animationDelay,
  ]);

  // Use in-view detection if enabled
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const isInView = useInView(buttonRef, inViewOptions);

  // Reset animation state when prop values change
  useEffect(() => {
    setHasAnimated(false);
    setCurrentStars(initialStars);
  }, [initialStars]);

  // Auto-start animation or use in-view trigger
  useEffect(() => {
    if (useInViewTrigger) {
      if (isInView && !hasAnimated) {
        startAnimation();
      }
    } else if (autoAnimate && !hasAnimated) {
      startAnimation();
    }
  }, [autoAnimate, useInViewTrigger, isInView, hasAnimated, startAnimation]);

  const navigateToRepo = (): void => {
    if (!repoUrl) {
      return;
    }

    // Next.js compatible navigation approach
    try {
      // Create a temporary anchor element for reliable navigation
      const link = document.createElement("a");
      link.href = repoUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      // Temporarily add to DOM and click
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      // Fallback to window.open
      try {
        window.open(repoUrl, "_blank", "noopener,noreferrer");
      } catch {
        // Final fallback
        window.location.href = repoUrl;
      }
    }
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (onClick) {
      onClick(event);
      return;
    }

    if (repoUrl) {
      navigateToRepo();
    } else if (!hasAnimated) {
      startAnimation();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // Handle Enter and Space key presses for accessibility
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();

      if (repoUrl) {
        navigateToRepo();
      } else if (!hasAnimated) {
        startAnimation();
      }
    }
  };

  return (
    <button
      ref={buttonRef}
      className={cn(
        githubButtonVariants({ variant, size }),
        separator && "ps-0",
        className
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label={repoUrl ? `Star ${label} on GitHub` : label}
      {...props}
    >
      {showGithubIcon && (
        <div
          className={cn(
            "relative flex h-full items-center justify-center",
            separator && "w-9 border-border border-r bg-muted/60"
          )}
        >
          <svg role="img" viewBox="0 0 24 24" fill="currentColor">
            <title>GitHub</title>
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
        </div>
      )}

      {label && <span>{label}</span>}

      {/* Animated Star Icon */}
      {showStarIcon && (
        <div className="relative inline-flex shrink-0">
          <Star
            className="fill-muted-foreground text-muted-foreground"
            aria-hidden="true"
          />
          <Star
            className="absolute start-0 top-0 fill-[var(--github-button-yellow)] text-[var(--github-button-yellow)]"
            size={18}
            aria-hidden="true"
            style={{
              clipPath: `inset(${100 - starProgress}% 0 0 0)`,
            }}
          />
        </div>
      )}

      {/* Animated Number Counter with Ticker Effect */}
      <div
        className={cn(
          "relative flex flex-col overflow-hidden font-semibold",
          starsClass
        )}
      >
        <motion.div
          animate={{ opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
            ...transition,
          }}
          className="tabular-nums"
        >
          <span>{currentStars > 0 && formatNumber(currentStars)}</span>
        </motion.div>
        {fixedWidth && (
          <span className="h-0 overflow-hidden tabular-nums opacity-0">
            {formatNumber(targetStars)}
          </span>
        )}
      </div>
    </button>
  );
}

export interface GithubButtonProps {
  username: string;
  repo: string;
  roundStars?: boolean;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline" | "inverse";
  showGithubIcon?: boolean;
  showStarIcon?: boolean;
  label?: string;
  animationDuration?: number;
  animationDelay?: number;
  autoAnimate?: boolean;
  initialStars?: number;
  targetStars?: number;
  useInViewTrigger?: boolean;
  inViewOptions?: UseInViewOptions;
  transition?: SpringOptions;
  separator?: boolean;
}

export function GithubButton({
  username,
  repo,
  roundStars = true,
  size = "default",
  variant = "default",
  showGithubIcon = true,
  showStarIcon = true,
  label = "",
  animationDuration = 2,
  animationDelay = 0,
  autoAnimate = false,
  initialStars = 0,
  targetStars = 0,
  useInViewTrigger = false,
  inViewOptions,
  transition,
  separator = false,
}: GithubButtonProps): ReactElement {
  const repoUrl = useMemo(
    () => `https://github.com/${username}/${repo}`,
    [username, repo]
  );

  return (
    <GithubButtonPrimitive
      repoUrl={repoUrl}
      variant={variant}
      size={size}
      roundStars={roundStars}
      showGithubIcon={showGithubIcon}
      showStarIcon={showStarIcon}
      label={label}
      animationDuration={animationDuration}
      animationDelay={animationDelay}
      autoAnimate={autoAnimate}
      initialStars={initialStars}
      targetStars={targetStars}
      useInViewTrigger={useInViewTrigger}
      {...(inViewOptions ? { inViewOptions } : {})}
      {...(transition ? { transition } : {})}
      separator={separator}
    />
  );
}
