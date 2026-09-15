// Control UI config module wires control ui chunking behavior.
function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

export function controlUiStableChunkName(id: string): string | undefined {
  const normalized = normalizeModuleId(id);

  // These entry-and-route helpers must stay together; separate shared chunks
  // turn small route-graph changes into extra startup preload requests.
  if (
    normalized.endsWith("/ui/src/components/config-form.shared.ts") ||
    normalized.endsWith("/ui/src/lib/clipboard.ts") ||
    normalized.endsWith("/ui/src/build-info-normalizers.ts") ||
    normalized.endsWith("/ui/src/build-info.ts")
  ) {
    return "control-ui-shared";
  }

  if (normalized.endsWith("/ui/src/lib/gateway-methods.ts")) {
    return "gateway-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "lit") ||
    moduleIdIncludesPackage(id, "lit-html") ||
    moduleIdIncludesPackage(id, "@lit/reactive-element")
  ) {
    return "lit-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "highlight.js") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "markdown-it-task-lists") ||
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    return "markdown-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "zod") ||
    moduleIdIncludesPackage(id, "json5") ||
    moduleIdIncludesPackage(id, "libphonenumber-js")
  ) {
    return "config-runtime";
  }

  // @noble/hashes stays out of this startup chunk deliberately: it is only
  // dynamically imported as the insecure-context fallback digest provider.
  if (moduleIdIncludesPackage(id, "@noble/ed25519") || moduleIdIncludesPackage(id, "ipaddr.js")) {
    return "gateway-runtime";
  }

  return undefined;
}

export const controlUiCodeSplitting = {
  includeDependenciesRecursively: false,
  groups: [
    {
      name: (id: string) => controlUiStableChunkName(id) ?? null,
      test: (id: string) => controlUiStableChunkName(id) !== undefined,
      priority: 20,
    },
    {
      name: (id: string) =>
        normalizeModuleId(id).includes("/ui/src/") ? "control-ui-core" : "control-ui-foundation",
      tags: ["$initial"] as ["$initial"],
      priority: 10,
      // Each partition this boundary creates is a startup request, and splitting
      // a shared graph also costs gzip because the parts compress worse apart
      // than together. At 576 KiB the initial graph had outgrown the boundary
      // and fragmented into 20 startup requests / 397437 B, tripping both the
      // request and gzip budgets; 1 MiB holds it in 13 requests / 393202 B.
      // Raising this is not free: it trades HTTP/1.1 parallelism for fewer,
      // larger requests, so keep it at the smallest value that holds the graph.
      maxSize: 1024 * 1024,
    },
  ],
};
