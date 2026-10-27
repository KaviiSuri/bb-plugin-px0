import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

// The SDK requires explicit extensions; it does not accept a wildcard.
export const FILE_EXTENSIONS = [
  "md", "mdx", "markdown", "txt", "log", "rst", "adoc",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "html", "htm", "css", "scss", "sass", "less", "svg",
  "py", "pyi", "go", "rs", "rb", "php", "java", "kt", "kts",
  "c", "h", "cpp", "hpp", "cc", "cs", "swift", "m", "mm",
  "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql",
  "vue", "svelte", "astro", "ex", "exs", "erl", "hrl", "hs",
  "lua", "r", "dart", "proto", "tf", "tfvars", "ini", "conf",
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif",
] as const;

export function workspaceFilePath(
  path: string,
  source: PluginFileOpenerSource,
  workspace: { path: string; environmentId: string; hostId: string },
): string | null {
  if (source.kind === "thread-storage") return null;
  if (source.environmentId && source.environmentId !== workspace.environmentId) return null;
  if (source.experimental_hostId && source.experimental_hostId !== workspace.hostId) return null;
  let relative = path;
  if (source.kind === "host") {
    const prefix = workspace.path.replace(/\/+$/, "") + "/";
    if (!path.startsWith(prefix)) return null;
    relative = path.slice(prefix.length);
  }
  // px0 can only navigate files within its workspace. Keep other links in BB.
  if (!relative || relative.startsWith("/") || relative.includes("\\") ||
      relative.split("/").includes("..")) return null;
  return relative;
}
