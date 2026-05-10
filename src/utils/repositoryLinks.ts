function readRepositoryUrl(): string {
  // Resolve once from package.json; bundler inlines this via require at build time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json") as { repository?: { url?: string } };
    const raw = pkg.repository?.url ?? "";
    return raw.replace(/^git\+/, "").replace(/\.git$/, "");
  } catch {
    return "https://github.com/evdanil/vscode-NexTerminal";
  }
}

function repositoryUrl(pathKind: "blob" | "tree", path: string): string {
  const base = readRepositoryUrl().replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${base}/${pathKind}/main/${cleanPath}`;
}

export function repositoryBlobUrl(path: string): string {
  return repositoryUrl("blob", path);
}

export function repositoryTreeUrl(path: string): string {
  return repositoryUrl("tree", path);
}
