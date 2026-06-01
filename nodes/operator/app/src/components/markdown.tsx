// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/markdown`
 * Purpose: Render trusted-source markdown (work-item bodies, knowledge text entries) as styled HTML.
 * Scope: GFM only. Raw embedded HTML is NOT rendered — arbitrary HTML belongs in the sandboxed
 *   `entryType=html` iframe path, never inline. This keeps the markdown lane injection-free.
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// `node` (a hast Element) is forwarded to every component by react-markdown; strip it
// via a rest-sibling destructure so it never lands on the DOM element.
const components: Components = {
  h1: ({ node, className, ...rest }) => (
    <h1
      className={cn("mt-6 mb-3 font-semibold text-2xl first:mt-0", className)}
      {...rest}
    />
  ),
  h2: ({ node, className, ...rest }) => (
    <h2
      className={cn("mt-6 mb-3 font-semibold text-xl first:mt-0", className)}
      {...rest}
    />
  ),
  h3: ({ node, className, ...rest }) => (
    <h3
      className={cn("mt-4 mb-2 font-semibold text-base first:mt-0", className)}
      {...rest}
    />
  ),
  h4: ({ node, className, ...rest }) => (
    <h4
      className={cn("mt-4 mb-2 font-semibold text-sm first:mt-0", className)}
      {...rest}
    />
  ),
  p: ({ node, className, ...rest }) => (
    <p
      className={cn("my-3 leading-7 first:mt-0 last:mb-0", className)}
      {...rest}
    />
  ),
  a: ({ node, className, ...rest }) => (
    <a
      className={cn(
        "font-medium text-primary underline underline-offset-4",
        className
      )}
      target="_blank"
      rel="noreferrer"
      {...rest}
    />
  ),
  ul: ({ node, className, ...rest }) => (
    <ul
      className={cn("my-3 ml-6 list-disc [&>li]:mt-1", className)}
      {...rest}
    />
  ),
  ol: ({ node, className, ...rest }) => (
    <ol
      className={cn("my-3 ml-6 list-decimal [&>li]:mt-1", className)}
      {...rest}
    />
  ),
  blockquote: ({ node, className, ...rest }) => (
    <blockquote
      className={cn(
        "my-3 border-l-2 pl-4 text-muted-foreground italic",
        className
      )}
      {...rest}
    />
  ),
  hr: ({ node, className, ...rest }) => (
    <hr className={cn("my-4 border-border", className)} {...rest} />
  ),
  table: ({ node, className, ...rest }) => (
    <div className="my-3 overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...rest} />
    </div>
  ),
  thead: ({ node, className, ...rest }) => (
    <thead
      className={cn("border-border border-b text-left", className)}
      {...rest}
    />
  ),
  tbody: ({ node, className, ...rest }) => (
    <tbody className={cn("divide-y divide-border", className)} {...rest} />
  ),
  th: ({ node, className, ...rest }) => (
    <th className={cn("px-3 py-1.5 font-semibold", className)} {...rest} />
  ),
  td: ({ node, className, ...rest }) => (
    <td className={cn("px-3 py-1.5", className)} {...rest} />
  ),
  pre: ({ node, className, ...rest }) => (
    <pre
      className={cn(
        "my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs",
        className
      )}
      {...rest}
    />
  ),
  code: ({ node, className, ...rest }) => {
    const isBlock =
      typeof className === "string" && className.includes("language-");
    return (
      <code
        className={
          isBlock ? className : "rounded bg-muted px-1 py-0.5 font-mono text-sm"
        }
        {...rest}
      />
    );
  },
};

interface MarkdownProps {
  readonly content: string;
  readonly className?: string;
}

/** Render `content` as GFM markdown. Raw HTML is escaped, not rendered. */
export function Markdown({ content, className }: MarkdownProps): ReactElement {
  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
