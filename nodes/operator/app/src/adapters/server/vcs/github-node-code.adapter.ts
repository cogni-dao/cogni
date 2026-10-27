// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-node-code`
 * Purpose: Bounded immutable Git-tree/blob evidence for the owning node.
 * Scope: Git object reads only, with host-owned identity and admitted source paths.
 * Invariants: No Contents symlink following; no raw-404 absence; reject secret paths before IO.
 * Side-effects: IO (injected GitHub App read transport).
 * Links: https://cognidao.org/work/items/subtask.5027
 * @internal
 */
import { createHash } from "node:crypto";
import type {
  NodeCodeBinding,
  NodeCodeCapability,
  NodeCodeListResult,
  NodeCodeReadResult,
  NodeCodeSource,
} from "@cogni/ai-tools";
import { z } from "zod";
import { EVENT_NAMES } from "@/shared/observability";

export type NodeCodeGitRoute =
  | "GET /repos/{owner}/{repo}/git/commits/{commit_sha}"
  | "GET /repos/{owner}/{repo}/git/trees/{tree_sha}"
  | "GET /repos/{owner}/{repo}/git/blobs/{file_sha}";
export type NodeCodeGitRequest = (
  route: NodeCodeGitRoute,
  params: Readonly<Record<string, string>>,
  signal: AbortSignal
) => Promise<unknown>;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const commitSchema = z.object({ sha, tree: z.object({ sha }) });
const treeEntrySchema = z.object({
  path: z.string().min(1).max(512),
  mode: z.string(),
  type: z.string(),
  sha,
  size: z.number().int().nonnegative().optional(),
});
const treeSchema = z.object({
  sha,
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema),
});
const blobSchema = z.object({
  sha,
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});
type Entry = z.infer<typeof treeEntrySchema>;
const MAX_TREE_ENTRIES = 500;
const MAX_FILE_BYTES = 131072;
const MAX_RANGE_BYTES = 32768;
const MAX_LIST_BYTES = 32768;
const MAX_RANGE_LINES = 200;
const SAFE_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|css|scss|toml)$/i;
const SECRET =
  /(?:secret|credential|password|certificate|private[-_]?key|\.env|\.pem$|\.key$|\.p12$|\.pfx$|\.crt$|\.cer$|\.der$|\.jks$|\.keystore$|\.tfstate)/i;

class SourceError extends Error {}

/** No normalization may turn an unsafe argument into a different admitted path. */
export function admittedNodeCodePath(
  binding: Pick<NodeCodeBinding, "roots" | "manifests">,
  path: string,
  directory = false
): boolean {
  if (directory && path === "") return true;
  const parts = path.split("/");
  if (
    path.length > 512 ||
    parts.length > 16 ||
    /[\\%]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    parts.some((p) => !p || p.startsWith(".") || SECRET.test(p))
  )
    return false;
  if (binding.manifests.includes(path)) return !directory;
  return (
    binding.roots.some(
      (root) =>
        path === root ||
        path.startsWith(`${root}/`) ||
        (directory && root.startsWith(`${path}/`))
    ) &&
    (directory || SAFE_EXT.test(path))
  );
}

export class GitHubNodeCodeAdapter implements NodeCodeCapability {
  private readonly binding: NodeCodeBinding;
  constructor(
    binding: NodeCodeBinding,
    private readonly request: NodeCodeGitRequest,
    private readonly log: {
      info(fields: Record<string, unknown>): void;
      warn(fields: Record<string, unknown>): void;
    }
  ) {
    // Capture immutable host policy; later caller mutations cannot widen a live reader.
    this.binding = {
      ...binding,
      roots: [...binding.roots],
      manifests: [...binding.manifests],
    };
    if (
      !/^[0-9a-f]{40}$/.test(binding.commitSha) ||
      !binding.nodeId ||
      !/^[A-Za-z0-9-]+$/.test(binding.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(binding.repo) ||
      new URL(binding.origin).origin !== binding.origin ||
      !["https:", "http:"].includes(new URL(binding.origin).protocol) ||
      binding.roots.some(
        (p) => !p || p.split("/").some((s) => !s || s.startsWith("."))
      ) ||
      binding.manifests.some((p) => !p || p.includes("/") || p.startsWith("."))
    )
      throw new Error("node_code_binding_invalid");
  }

  private source(path: string): NodeCodeSource {
    const b = this.binding;
    return {
      nodeId: b.nodeId,
      origin: b.origin,
      repo: `${b.owner}/${b.repo}`,
      commitSha: b.commitSha,
      path: path || ".",
      citation: `https://github.com/${b.owner}/${b.repo}/tree/${b.commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`,
      complete: false,
      exists: null,
    };
  }

  private async object(
    route: NodeCodeGitRoute,
    id: string,
    signal: AbortSignal
  ): Promise<unknown> {
    const b = this.binding;
    const param = route.endsWith("{commit_sha}")
      ? "commit_sha"
      : route.endsWith("{tree_sha}")
        ? "tree_sha"
        : "file_sha";
    return this.request(
      route,
      { owner: b.owner, repo: b.repo, [param]: id },
      signal
    );
  }

  private async tree(treeSha: string, signal: AbortSignal): Promise<Entry[]> {
    const parsed = treeSchema.safeParse(
      await this.object(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        treeSha,
        signal
      )
    );
    if (!parsed.success || parsed.data.sha !== treeSha)
      throw new SourceError("node_code_tree_invalid");
    const data = parsed.data;
    if (data.truncated || data.tree.length > MAX_TREE_ENTRIES)
      throw new SourceError("node_code_tree_incomplete");
    const names = new Set<string>();
    for (const entry of data.tree) {
      // The non-recursive Git API must return unique direct names, never paths to descendants.
      if (entry.path.includes("/") || names.has(entry.path))
        throw new SourceError("node_code_tree_invalid");
      names.add(entry.path);
    }
    return data.tree;
  }

  private async resolve(
    path: string,
    signal: AbortSignal
  ): Promise<Entry | null> {
    const b = this.binding;
    const parsed = commitSchema.safeParse(
      await this.object(
        "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
        b.commitSha,
        signal
      )
    );
    if (!parsed.success || parsed.data.sha !== b.commitSha)
      throw new SourceError("node_code_commit_unavailable");
    let treeSha = parsed.data.tree.sha;
    if (!path) return { path: "", mode: "040000", type: "tree", sha: treeSha };
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const entries = await this.tree(treeSha, signal);
      const entry = entries.find((e) => e.path === parts[i]);
      if (!entry) return null; // Accessible immutable commit + complete authoritative parent coverage.
      if (entry.mode === "120000" || entry.mode === "160000")
        throw new SourceError("node_code_link_denied");
      if (i === parts.length - 1) return entry;
      if (entry.mode !== "040000" || entry.type !== "tree")
        throw new SourceError("node_code_parent_not_directory");
      treeSha = entry.sha;
    }
    throw new SourceError("node_code_path_unresolved");
  }

  private reason(error: unknown): string {
    // GitHub 404 may hide private resources; preserve unknown existence for every transport/auth error.
    return error instanceof SourceError
      ? error.message
      : "node_code_source_unavailable";
  }

  async read(input: {
    path: string;
    lineStart?: number;
    lineEnd?: number;
  }): Promise<NodeCodeReadResult> {
    const base: NodeCodeReadResult = {
      ...this.source(input.path),
      content: null,
      sha256: null,
      lineStart: null,
      lineEnd: null,
      totalLines: null,
      fileComplete: false,
    };
    if (!admittedNodeCodePath(this.binding, input.path))
      return { ...base, reason: "node_code_path_denied" };
    const start = input.lineStart ?? 1;
    const end = input.lineEnd ?? start + MAX_RANGE_LINES - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start + 1 > MAX_RANGE_LINES
    )
      return { ...base, reason: "node_code_range_denied" };
    const begun = Date.now();
    try {
      const signal = AbortSignal.timeout(15000);
      const entry = await this.resolve(input.path, signal);
      if (!entry)
        return {
          ...base,
          complete: true,
          exists: false,
          reason: "node_code_path_absent",
        };
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new SourceError("node_code_not_regular_file");
      if (entry.size === undefined || entry.size > MAX_FILE_BYTES)
        throw new SourceError("node_code_file_incomplete");
      const parsed = blobSchema.safeParse(
        await this.object(
          "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          entry.sha,
          signal
        )
      );
      if (
        !parsed.success ||
        parsed.data.sha !== entry.sha ||
        parsed.data.size !== entry.size
      )
        throw new SourceError("node_code_blob_invalid");
      const blob = parsed.data;
      if (blob.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4096)
        throw new SourceError("node_code_file_incomplete");
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length !== blob.size || bytes.includes(0))
        throw new SourceError("node_code_blob_invalid");
      const blobSha = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blobSha !== entry.sha)
        throw new SourceError("node_code_blob_invalid");
      const body = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (start > Math.max(lines.length, 1))
        throw new SourceError("node_code_range_outside_file");
      const actualEnd = Math.min(end, lines.length);
      const content = lines.slice(start - 1, actualEnd).join("");
      if (Buffer.byteLength(content, "utf8") > MAX_RANGE_BYTES)
        throw new SourceError("node_code_range_incomplete");
      const first = lines.length === 0 ? 0 : start;
      const citation = `https://github.com/${base.repo}/blob/${base.commitSha}/${input.path.split("/").map(encodeURIComponent).join("/")}${first ? `#L${first}-L${actualEnd}` : ""}`;
      return {
        ...base,
        complete: true,
        exists: true,
        content,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        lineStart: first,
        lineEnd: actualEnd,
        totalLines: lines.length,
        fileComplete: start === 1 && actualEnd === lines.length,
        citation,
      };
    } catch (error) {
      const reason = this.reason(error);
      this.log.warn({
        event: EVENT_NAMES.ADAPTER_GITHUB_NODE_CODE_ERROR,
        operation: "read",
        reasonCode: reason,
        durationMs: Date.now() - begun,
      });
      return { ...base, reason };
    }
  }

  async list(input: { path: string }): Promise<NodeCodeListResult> {
    const path = input.path === "." ? "" : input.path;
    const base = { ...this.source(path), entries: [] };
    if (!admittedNodeCodePath(this.binding, path, true))
      return { ...base, reason: "node_code_path_denied" };
    const begun = Date.now();
    try {
      const signal = AbortSignal.timeout(15000);
      const entry = await this.resolve(path, signal);
      if (!entry)
        return {
          ...base,
          complete: true,
          exists: false,
          reason: "node_code_path_absent",
        };
      if (entry.type !== "tree" || entry.mode !== "040000")
        throw new SourceError("node_code_not_directory");
      const children = await this.tree(entry.sha, signal);
      const entries: NodeCodeListResult["entries"][number][] = [];
      for (const child of children) {
        const childPath = path ? `${path}/${child.path}` : child.path;
        const directory = child.mode === "040000" && child.type === "tree";
        const file =
          ["100644", "100755"].includes(child.mode) && child.type === "blob";
        // Omitting an admitted symlink/submodule would make a complete listing falsely imply absence.
        // Refuse existence coverage for this directory instead of presenting that omission as proof.
        if (
          !directory &&
          !file &&
          (admittedNodeCodePath(this.binding, childPath, true) ||
            admittedNodeCodePath(this.binding, childPath))
        )
          throw new SourceError("node_code_listing_incomplete");
        if (
          (directory || file) &&
          admittedNodeCodePath(this.binding, childPath, directory)
        )
          entries.push({
            path: childPath,
            type: directory ? "directory" : "file",
            sha: child.sha,
          });
      }
      if (Buffer.byteLength(JSON.stringify(entries), "utf8") > MAX_LIST_BYTES)
        throw new SourceError("node_code_listing_incomplete");
      return { ...base, complete: true, exists: true, entries };
    } catch (error) {
      const reason = this.reason(error);
      this.log.warn({
        event: EVENT_NAMES.ADAPTER_GITHUB_NODE_CODE_ERROR,
        operation: "list",
        reasonCode: reason,
        durationMs: Date.now() - begun,
      });
      return { ...base, reason };
    }
  }
}
