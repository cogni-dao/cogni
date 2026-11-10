// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/export/_lib/obsidian-vault`
 * Purpose: Pure serializer that turns knowledge rows + citation edges into an Obsidian vault — one Markdown note per entry, foldered by domain, citations rendered as `[[wikilinks]]`.
 * Scope: Pure function only. No I/O, no zip, no framework. The route layer reads the store, calls this, and zips the result.
 * Invariants:
 *   - DETERMINISTIC: identical input → byte-identical output (no clock, no Math.random; rows sorted by id, edges by type+target).
 *   - LINK_BY_UNIQUE_NOTE_NAME: every entry gets a vault-unique note basename so `[[name]]` resolves regardless of folder.
 *   - PROVENANCE_IN_FRONTMATTER: id/domain/entry_type/source_type/confidence land in YAML frontmatter; `aliases: [id]` keeps `[[id]]` resolvable.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md, ../route.ts
 * @public
 */

import type { Citation, Domain, Knowledge } from "@cogni/knowledge-store";

export interface VaultEntry {
  entry: Knowledge;
  /** Outgoing citation edges (this entry cites others). */
  citations: Citation[];
}

export interface VaultInput {
  domains: Domain[];
  entries: VaultEntry[];
}

export interface VaultFile {
  /** POSIX path relative to the vault root, e.g. "engineering/foo.md". */
  path: string;
  content: string;
}

const MAX_SLUG_LEN = 80;

function slug(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "untitled";
}

function yamlStr(v: string): string {
  return `"${v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

function yamlList(items: readonly string[]): string {
  return `[${items.map(yamlStr).join(", ")}]`;
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString();
  return d;
}

/**
 * Assign each entry a vault-unique note basename. Base is the title slug;
 * collisions are disambiguated with the entry id (ids are unique), so links
 * stay stable and human-readable.
 */
function buildNoteNames(entries: VaultEntry[]): Map<string, string> {
  const byId = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...entries].sort((a, b) =>
    a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
  );
  for (const { entry } of sorted) {
    const base = slug(entry.title);
    let name = base;
    if (used.has(name.toLowerCase())) {
      name = `${base}-${slug(entry.id)}`;
      let n = 2;
      while (used.has(name.toLowerCase())) {
        name = `${base}-${slug(entry.id)}-${n}`;
        n += 1;
      }
    }
    used.add(name.toLowerCase());
    byId.set(entry.id, name);
  }
  return byId;
}

function renderFrontmatter(entry: Knowledge): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlStr(entry.title)}`);
  lines.push(`id: ${yamlStr(entry.id)}`);
  lines.push(`aliases: ${yamlList([entry.id])}`);
  lines.push(`domain: ${yamlStr(entry.domain)}`);
  lines.push(`entry_type: ${yamlStr(entry.entryType ?? "finding")}`);
  lines.push(`source_type: ${yamlStr(entry.sourceType)}`);
  if (entry.sourceRef) lines.push(`source_ref: ${yamlStr(entry.sourceRef)}`);
  if (entry.confidencePct != null) {
    lines.push(`confidence_pct: ${entry.confidencePct}`);
  }
  if (entry.tags && entry.tags.length > 0) {
    lines.push(`tags: ${yamlList(entry.tags)}`);
  }
  const created = isoOrNull(entry.createdAt);
  if (created) lines.push(`created_at: ${yamlStr(created)}`);
  lines.push("---");
  return lines.join("\n");
}

function renderCitations(
  citations: Citation[],
  noteNameById: Map<string, string>
): string {
  if (citations.length === 0) return "";
  const sorted = [...citations].sort((a, b) => {
    if (a.citationType !== b.citationType) {
      return a.citationType < b.citationType ? -1 : 1;
    }
    return a.citedId < b.citedId ? -1 : a.citedId > b.citedId ? 1 : 0;
  });
  const lines = ["", "## Citations", ""];
  for (const c of sorted) {
    // Fall back to the raw id when the cited entry is outside the export scope
    // (e.g. a domain filter) — Obsidian renders it as an unresolved link.
    const target = noteNameById.get(c.citedId) ?? c.citedId;
    const ctx = c.context ? ` — ${c.context.replace(/[\r\n]+/g, " ")}` : "";
    lines.push(`- **${c.citationType}** → [[${target}]]${ctx}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderReadme(input: VaultInput): string {
  const counts = new Map<string, number>();
  for (const { entry } of input.entries) {
    counts.set(entry.domain, (counts.get(entry.domain) ?? 0) + 1);
  }
  const domains = [...input.domains].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const lines = [
    "# Cogni Knowledge Vault",
    "",
    `Exported from the Cogni knowledge hub. ${input.entries.length} entries across ${domains.length} domains.`,
    "",
    "Open this folder as an Obsidian vault and use the graph view to explore the citation DAG. Each note is one knowledge entry; links are citation edges.",
    "",
    "| Domain | Entries | Description |",
    "| --- | --- | --- |",
  ];
  for (const d of domains) {
    const desc = (d.description ?? "")
      .replace(/\|/g, "\\|")
      .replace(/[\r\n]+/g, " ");
    lines.push(`| ${d.id} | ${counts.get(d.id) ?? 0} | ${desc} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build an Obsidian vault (a flat list of files) from knowledge rows + edges.
 * The caller is responsible for archiving the files (e.g. zip).
 */
export function buildObsidianVault(input: VaultInput): VaultFile[] {
  const noteNameById = buildNoteNames(input.entries);
  const files: VaultFile[] = [
    { path: "README.md", content: renderReadme(input) },
  ];

  const sorted = [...input.entries].sort((a, b) =>
    a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
  );
  for (const { entry, citations } of sorted) {
    const noteName = noteNameById.get(entry.id);
    if (!noteName) continue;
    const body = [
      renderFrontmatter(entry),
      "",
      `# ${entry.title}`,
      "",
      entry.content,
      renderCitations(citations, noteNameById),
    ].join("\n");
    files.push({
      path: `${slug(entry.domain)}/${noteName}.md`,
      content: `${body}\n`,
    });
  }
  return files;
}
