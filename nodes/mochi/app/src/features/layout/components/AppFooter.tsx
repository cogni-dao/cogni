// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppFooter`
 * Purpose: Data-driven site footer with link columns, brand section, and social icons.
 * Scope: Renders footer for public pages. Does not handle authentication or dynamic content.
 * Invariants: Columns sourced from footer-items.ts; external links open in new tab.
 * Side-effects: none
 * Links: src/features/layout/components/footer-items.ts
 * @public
 */

import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { FOOTER_COLUMNS, SOCIAL_LINKS } from "./footer-items";

export function AppFooter(): ReactElement {
  return (
    <footer className="border-t bg-muted/40">
      {/* Link columns */}
      <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Brand column */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <Image
                src="/TransparentBrainOnly.png"
                alt="Cogni"
                width={24}
                height={24}
              />
              <span className="font-bold text-gradient-accent">Cogni</span>
            </Link>
            <p className="mt-3 text-muted-foreground text-sm">
              Web3 Gov + Web2 AI
            </p>
          </div>

          {FOOTER_COLUMNS.map((column) => (
            <div key={column.title}>
              <h3 className="font-semibold text-foreground text-sm">
                {column.title}
              </h3>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar — full width */}
      <div className="border-t">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
          <p className="text-muted-foreground text-xs">
            &copy; {new Date().getFullYear()} Cogni DAO
          </p>
          <div className="flex items-center gap-5">
            {SOCIAL_LINKS.map(({ label, href, icon: Icon }) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon className="h-5 w-5" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
