// .dependency-cruiser.cjs
// Hexagonal architecture boundaries enforced via dependency-cruiser.
// Pure policy config - scope controlled via CLI --include-only flag.
// Production: depcruise nodes/operator/app/src packages services --include-only '^(nodes/operator/app/src|packages|services)' --output-type err-long
// Arch probes: depcruise nodes/operator/app/src/__arch_probes__ --include-only '^nodes/operator/app/src/__arch_probes__' --output-type err

/** @type {import('dependency-cruiser').IConfiguration} */

// src/ hexagonal layers
const srcLayers = {
  core: "^nodes/operator/app/src/core",
  ports: "^nodes/operator/app/src/ports",
  features: "^nodes/operator/app/src/features",
  app: "^nodes/operator/app/src/app",
  adapters: "^nodes/operator/app/src/adapters",
  adaptersServer: "^nodes/operator/app/src/adapters/server",
  adaptersTest: "^nodes/operator/app/src/adapters/test",
  // adaptersWorker, adaptersCli: add when implemented
  shared: "^nodes/operator/app/src/shared",
  bootstrap: "^nodes/operator/app/src/bootstrap",
  lib: "^nodes/operator/app/src/lib",
  auth: "^nodes/operator/app/src/auth\\.ts$",
  proxy: "^nodes/operator/app/src/proxy\\.ts$",
  components: "^nodes/operator/app/src/components",
  styles: "^nodes/operator/app/src/styles",
  types: "^nodes/operator/app/src/types",
  assets: "^nodes/operator/app/src/assets",
  contracts: "^nodes/operator/app/src/contracts",
  mcp: "^nodes/operator/app/src/mcp",
  scripts: "^nodes/operator/app/src/scripts",
};

// Monorepo boundary layers (packages/)
const monorepoLayers = {
  packages: "^packages/",
  nodes: "^nodes/",
  // services: "^services/",
};

const layers = { ...srcLayers, ...monorepoLayers };

// Only src/ layers are checked for "unknown layer" violations
const knownSrcLayerPatterns = Object.values(srcLayers);

module.exports = {
  options: {
    // Use TS path resolution so @/aliases resolve to src/** correctly
    tsConfig: {
      fileName: "./tsconfig.base.json",
    },

    // Track TypeScript type-only imports
    tsPreCompilationDeps: true,

    // Normal dependency-cruiser hygiene
    doNotFollow: {
      path: "node_modules",
    },
  },

  allowedSeverity: "error",

  allowed: [
    // core → core, types
    {
      from: { path: layers.core },
      to: { path: [layers.core, layers.types] },
    },

    // ports → ports, core, types
    {
      from: { path: layers.ports },
      to: { path: [layers.ports, layers.core, layers.types] },
    },

    // features → features, ports, core, shared, types, components, contracts
    {
      from: { path: layers.features },
      to: {
        path: [
          layers.features,
          layers.ports,
          layers.core,
          layers.shared,
          layers.types,
          layers.components,
          layers.contracts,
        ],
      },
    },

    // contracts → contracts, shared, types
    {
      from: { path: layers.contracts },
      to: { path: [layers.contracts, layers.shared, layers.types] },
    },

    // app → app, features, ports, shared, lib, contracts, types, components, styles, bootstrap, auth
    {
      from: { path: layers.app },
      to: {
        path: [
          layers.app,
          layers.features,
          layers.ports,
          layers.shared,
          layers.lib,
          layers.contracts,
          layers.types,
          layers.components,
          layers.styles,
          layers.bootstrap,
          layers.auth,
        ],
      },
    },

    // lib → lib, ports, shared, types, auth
    {
      from: { path: layers.lib },
      to: {
        path: [
          layers.lib,
          layers.ports,
          layers.shared,
          layers.types,
          layers.auth,
        ],
      },
    },

    // auth → auth, adapters, shared, types (bootstrap-level: framework wiring)
    {
      from: { path: layers.auth },
      to: {
        path: [layers.auth, layers.adapters, layers.shared, layers.types],
      },
    },

    // proxy → auth, lib, shared, types (edge layer: middleware)
    {
      from: { path: layers.proxy },
      to: { path: [layers.auth, layers.lib, layers.shared, layers.types] },
    },

    // mcp → mcp, features, ports, contracts, bootstrap
    {
      from: { path: layers.mcp },
      to: {
        path: [
          layers.mcp,
          layers.features,
          layers.ports,
          layers.contracts,
          layers.bootstrap,
        ],
      },
    },

    // adapters/server → adapters/server, ports, shared, types
    {
      from: { path: layers.adaptersServer },
      to: {
        path: [
          layers.adaptersServer,
          layers.ports,
          layers.shared,
          layers.types,
        ],
      },
    },

    // adapters/test → adapters/test, ports, shared, types
    {
      from: { path: layers.adaptersTest },
      to: {
        path: [layers.adaptersTest, layers.ports, layers.shared, layers.types],
      },
    },

    // shared → shared, types
    {
      from: { path: layers.shared },
      to: { path: [layers.shared, layers.types] },
    },

    // bootstrap → bootstrap, ports, adapters, shared, types
    {
      from: { path: layers.bootstrap },
      to: {
        path: [
          layers.bootstrap,
          layers.ports,
          layers.adapters,
          layers.shared,
          layers.types,
        ],
      },
    },

    // components → components, shared, types, styles
    {
      from: { path: layers.components },
      to: {
        path: [layers.components, layers.shared, layers.types, layers.styles],
      },
    },

    // styles → styles only
    {
      from: { path: layers.styles },
      to: { path: [layers.styles] },
    },

    // assets → assets only
    {
      from: { path: layers.assets },
      to: { path: [layers.assets] },
    },

    // types → types only (leaf layer: pure type definitions)
    {
      from: { path: layers.types },
      to: { path: [layers.types] },
    },

    // =========================================================================
    // Monorepo package rules
    // =========================================================================

    // packages/ can import within itself (internal)
    {
      from: { path: "^packages/" },
      to: { path: "^packages/" },
    },

    // src/ can import from packages/ (consumption)
    {
      from: { path: "^nodes/operator/app/src/" },
      to: { path: "^packages/" },
    },

    // services/ can import from packages/ (consumption)
    {
      from: { path: "^services/" },
      to: { path: "^packages/" },
    },

    // services/ can import within itself (internal)
    {
      from: { path: "^services/" },
      to: { path: "^services/" },
    },

    // nodes/ can import within itself (node-local)
    // Exclude operator/app/src/ — operator has full layer enforcement via srcLayers rules above.
    // Other nodes get blanket pass until they gain layer enforcement.
    {
      from: { path: "^nodes/(?!operator/app/src/)" },
      to: { path: "^nodes/" },
    },

    // nodes/ can import from shared packages
    {
      from: { path: "^nodes/" },
      to: { path: "^packages/" },
    },

    // scripts → bootstrap (CLI wrappers that call job modules)
    {
      from: { path: "^nodes/operator/app/src/scripts" },
      to: { path: ["^nodes/operator/app/src/bootstrap"] },
    },

    // Files not in a known layer are caught by the forbidden `no-unknown-layer` rule below.
  ],

  forbidden: [
    // Enforce "no-unknown-files": any file in src/** not covered by a known layer pattern is an error.
    {
      name: "no-unknown-src-layer",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src",
        pathNot: knownSrcLayerPatterns,
      },
      to: {},
    },

    // Block parent-relative imports (../) - use @/ aliases instead
    {
      severity: "error",
      from: {
        path: "^nodes/operator/app/src",
      },
      to: {
        path: "\\.\\./",
      },
    },

    // Entry point enforcement: block internal module imports
    // ports: must use @/ports (index.ts) or @/ports/server.ts, not internal port files.
    // index.ts is the client-safe surface; server.ts re-exports @cogni/scheduler-core
    // which transitively uses node:util and must not enter client bundles.
    // See bug.0147 for the environment-safe split rationale.
    {
      name: "no-internal-ports-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(?!ports/)",
      },
      to: {
        path: "^nodes/operator/app/src/ports/(?!index\\.ts$|server\\.ts$).*\\.ts$",
      },
      comment:
        "Import from @/ports (index.ts) or @/ports/server (server-only scheduler ports), not internal port files",
    },

    // core: must use @/core (public.ts), not internal core files
    {
      name: "no-internal-core-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(?!core/)",
      },
      to: {
        path: "^nodes/operator/app/src/core/(?!public\\.ts$).*\\.ts$",
      },
      comment: "Import from @/core (public.ts), not internal core files",
    },

    // adapters/server: must use @/adapters/server (index.ts), not internal files
    // Exceptions (composition-root files that wire providers directly):
    //   auth.ts: bootstrap file that imports adapter internals
    //   container.ts: wires both trust boundaries (appDb + serviceDb)
    //   graph-executor.factory.ts: lazy-imports sandbox provider (avoids Turbopack bundling dockerode native addon)
    //   agent-discovery.ts: imports sandbox catalog provider (no native deps in import chain)
    {
      name: "no-internal-adapter-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(?!adapters/server/)(?!auth\\.ts$)(?!bootstrap/container\\.ts$)(?!bootstrap/graph-executor\\.factory\\.ts$)(?!bootstrap/agent-discovery\\.ts$)(?!bootstrap/jobs/syncGovernanceSchedules\\.job\\.ts$)(?!bootstrap/jobs/syncNodeSchedules\\.job\\.ts$)",
      },
      to: {
        path: "^nodes/operator/app/src/adapters/server/(?!index\\.ts$).*\\.ts$",
      },
      comment:
        "Import from @/adapters/server (index.ts), not internal adapter files. " +
        "Exempt: auth.ts (bootstrap), container.ts (trust boundaries), " +
        "graph-executor.factory.ts + agent-discovery.ts (sandbox subpath imports " +
        "to avoid Turbopack bundling dockerode native addon chain), " +
        "syncGovernanceSchedules.job.ts + syncNodeSchedules.job.ts (need serviceDb for advisory lock).",
    },

    // adapters/test: must use @/adapters/test (index.ts), not internal files
    {
      name: "no-internal-test-adapter-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(?!adapters/test/)",
      },
      to: {
        path: "^nodes/operator/app/src/adapters/test/(?!index\\.ts$).*\\.ts$",
      },
      comment:
        "Import from @/adapters/test (index.ts), not internal test adapter files",
    },

    // features: only allow services/ and components/ subdirectories
    {
      name: "no-internal-features-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(?!features/)",
      },
      to: {
        path: "^nodes/operator/app/src/features/[^/]+/(mappers|utils|constants)/",
      },
      comment:
        "Only import from features/*/services or features/*/components subdirectories",
    },

    // AI _facades: must import from features/ai/public.ts, never features/ai/services/*
    // Prevents app-layer bypassing the feature boundary
    // TODO: Extend to all facades after refactor PR
    {
      name: "no-ai-facades-to-feature-services",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/app/_facades/ai/",
      },
      to: {
        path: "^nodes/operator/app/src/features/ai/services/",
      },
      comment:
        "AI app facades must import from features/ai/public.ts, not internal services",
    },

    // =========================================================================
    // Monorepo boundary rules: packages/, services/, src/ isolation
    // =========================================================================

    // packages/ cannot import from src/ or services/
    {
      name: "no-packages-to-src-or-services",
      severity: "error",
      from: {
        path: "^packages/",
      },
      to: {
        path: ["^nodes/operator/app/src/", "^services/"],
      },
      comment:
        "packages/ must be standalone; cannot depend on src/ or services/",
    },

    // services/ cannot import from src/
    {
      name: "no-services-to-src",
      severity: "error",
      from: {
        path: "^services/",
      },
      to: {
        path: "^nodes/operator/app/src/",
      },
      comment: "services/ cannot depend on Next.js app code in src/",
    },

    // nodes/ cannot import operator apps/ or services/
    {
      name: "node-not-operator",
      severity: "error",
      from: {
        path: "^nodes/",
      },
      to: {
        path: ["^apps/", "^services/"],
      },
      comment: "nodes/ must not depend on operator apps/ or services/",
    },

    // shared packages cannot depend on node-specific code
    {
      name: "shared-not-node",
      severity: "error",
      from: {
        path: "^packages/",
      },
      to: {
        path: "^nodes/",
      },
      comment: "packages/ are shared and must not depend on node-specific code",
    },

    // nodes cannot import other nodes (except itself)
    {
      name: "no-cross-node",
      severity: "error",
      from: {
        path: "^nodes/([^/]+)/",
      },
      to: {
        path: "^nodes/([^/]+)/",
        pathNot: "^nodes/$1/",
      },
      comment: "node code must not import from another node directory",
    },

    // src/ cannot import from services/
    {
      name: "no-src-to-services",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/",
      },
      to: {
        path: "^services/",
      },
      comment: "src/ cannot depend on standalone services",
    },

    // Block deep imports into package internals (force use of package exports)
    // Allows index.ts (entrypoint) and declared sub-path exports (db-client/service)
    {
      name: "no-deep-package-imports",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/",
      },
      to: {
        path: "^packages/[^/]+/src/(?!index\\.ts$)",
        pathNot: "^packages/db-client/(src|dist)/service\\.(ts|js)$",
      },
      comment:
        "Import from package root or declared sub-path exports, not internal paths",
    },

    // NOTE: NO_LANGCHAIN_IN_SRC is enforced via Biome noRestrictedImports
    // (biome/base.json) which blocks @langchain/** imports in src/.
    // src/ CAN import from @cogni/langgraph-graphs for InProc execution path.

    // =========================================================================
    // ai-core kernel boundary (AI_CORE_IS_KERNEL)
    // =========================================================================

    // ai-core cannot import ai-tools (ai-core defines interfaces; ai-tools implements)
    {
      name: "no-ai-core-to-ai-tools",
      severity: "error",
      from: {
        path: "^packages/ai-core/",
      },
      to: {
        path: "^packages/ai-tools/",
      },
      comment:
        "ai-core defines runtime interfaces; ai-tools implements them. No reverse dependency.",
    },

    // Graph code cannot import ai-core directly (per ARCH_SINGLE_EXECUTION_PATH)
    // Graphs receive ToolExecFn via DI; they must not access BoundToolRuntime
    {
      name: "no-graphs-to-ai-core",
      severity: "error",
      from: {
        path: "^packages/langgraph-graphs/src/graphs/",
      },
      to: {
        path: "^packages/ai-core/",
      },
      comment:
        "Graph code uses ToolExecFn via runtime layer. Direct ai-core imports would bypass toolRunner.",
    },

    // =========================================================================
    // Scheduler package boundary rules (per PACKAGES_ARCHITECTURE.md)
    // =========================================================================

    // db-schema: refs is the root — imports nothing from other slices
    {
      name: "no-refs-to-slices",
      severity: "error",
      from: {
        path: "^packages/db-schema/src/refs",
      },
      to: {
        path: "^packages/db-schema/src/(scheduling|auth|billing|ai)",
      },
      comment: "refs.ts is the FK root; must not import from domain slices",
    },

    // db-schema: slices cannot import each other (only refs allowed)
    {
      name: "no-cross-slice-schema-imports",
      severity: "error",
      from: {
        path: "^packages/db-schema/src/(scheduling|auth|billing|ai)\\.ts$",
      },
      to: {
        path: "^packages/db-schema/src/(scheduling|auth|billing|ai)\\.ts$",
      },
      comment: "Domain slices import from /refs only, never from each other",
    },

    // db-client must only be imported in server layers (prevent client bundle pollution)
    // Allowed: bootstrap, adapters, app/api (server routes), app/_facades, app/_lib
    // Blocked: features (may be used client-side), components, core, etc.
    {
      name: "db-client-server-only",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/(features|components|core|styles|assets)/",
      },
      to: {
        path: "^packages/db-client/",
      },
      comment:
        "db-client contains postgres/drizzle; only server layers may import",
    },

    // Layer 1 (package): @cogni/db-client/service only from the service-client adapter.
    // Depcruiser resolves workspace sub-path exports to dist/, so match both src/ and dist/.
    {
      name: "no-service-db-package-import",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/",
        pathNot:
          "^nodes/operator/app/src/adapters/server/db/drizzle\\.service-client\\.ts$",
      },
      to: {
        path: "^packages/db-client/(src|dist)/service\\.(ts|js)$",
      },
      comment:
        "Only drizzle.service-client.ts may import @cogni/db-client/service (BYPASSRLS)",
    },

    // Layer 2 (adapter): drizzle.service-client.ts only from auth.ts (+ explicit allowlist).
    // This prevents the BYPASSRLS singleton from leaking through barrels.
    {
      name: "no-service-db-adapter-import",
      severity: "error",
      from: {
        path: "^nodes/operator/app/src/",
        pathNot:
          "^nodes/operator/app/src/(auth\\.ts|bootstrap/container\\.ts|bootstrap/jobs/syncGovernanceSchedules\\.job\\.ts|bootstrap/jobs/syncNodeSchedules\\.job\\.ts)$",
      },
      to: {
        path: "^nodes/operator/app/src/adapters/server/db/drizzle\\.service-client\\.ts$",
      },
      comment:
        "Only auth.ts, container.ts, and the governance + node schedule jobs may import the service-db adapter (BYPASSRLS singleton)",
    },

    // =========================================================================
    // Services internal clean architecture (opt-in when folders exist)
    // =========================================================================

    // core/ and ports/ cannot import from adapters/
    {
      name: "no-service-core-or-ports-to-adapters",
      severity: "error",
      from: {
        path: "^services/[^/]+/src/(core|ports)/",
      },
      to: {
        path: "^services/[^/]+/src/adapters/",
      },
      comment: "core/ports cannot depend on adapters (clean architecture)",
    },

    // adapters/ cannot import main.ts (composition root)
    {
      name: "no-service-adapters-to-main",
      severity: "error",
      from: {
        path: "^services/[^/]+/src/adapters/",
      },
      to: {
        path: "^services/[^/]+/src/main\\.ts$",
      },
      comment: "adapters must not import the composition root",
    },

    // activities/ and workflows/ cannot import adapters/ (clean architecture)
    {
      name: "no-service-activities-to-adapters",
      severity: "error",
      from: {
        path: "^services/[^/]+/src/(activities|workflows)/",
      },
      to: {
        path: "^services/[^/]+/src/adapters/",
      },
      comment:
        "activities/workflows depend on ports, not adapters (clean architecture)",
    },

    // activities/ and workflows/ cannot import @cogni/db-client (concrete adapter package)
    {
      name: "no-service-activities-to-db-client",
      severity: "error",
      from: {
        path: "^services/[^/]+/src/(activities|workflows)/",
      },
      to: {
        path: "^packages/db-client/",
      },
      comment:
        "activities/workflows use port interfaces, not concrete DB adapters",
    },

    // activities/ and workflows/ cannot import bootstrap/ (composition root)
    {
      name: "no-service-activities-to-bootstrap",
      severity: "error",
      from: {
        path: "^services/[^/]+/src/(activities|workflows)/",
      },
      to: {
        path: "^services/[^/]+/src/bootstrap/",
      },
      comment: "activities/workflows must not reach into the composition root",
    },

    // =========================================================================
    // Scheduler worker boundary rules (per SCHEDULER_SPEC.md)
    // =========================================================================

    // scheduler-worker must not import schedule-control modules (WORKER_NEVER_CONTROLS_SCHEDULES)
    {
      name: "no-worker-schedule-control",
      severity: "error",
      from: {
        path: "^services/scheduler-worker/",
      },
      to: {
        path: ["schedule-control", "ScheduleControl"],
      },
      comment:
        "Per WORKER_NEVER_CONTROLS_SCHEDULES: worker executes workflows only, CRUD endpoints are schedule authority",
    },

    // scheduler-worker activities/workflows must dispatch allocators through
    // attribution-pipeline-contracts, not import allocation.ts directly.
    {
      name: "no-worker-direct-ledger-allocation-subpath",
      severity: "error",
      from: {
        path: "^services/scheduler-worker/src/(activities|workflows)/",
      },
      to: {
        path: "^packages/attribution-ledger/src/allocation\\.ts$",
      },
      comment:
        "Worker allocation must go through plugin registry dispatch, not direct ledger allocation imports",
    },

    // =========================================================================
    // Pure-policy boundary rules (PURE_POLICY_NO_IO)
    // nodes/poly/packages/market-provider/src/policy/** is the pure decision layer for
    // redeem / close / exit policies. It must not import any I/O (viem,
    // @polymarket/clob-client*) or any app/bootstrap code. Bug.0384's predicate
    // defect was made possible because the prior in-line decideRedeem was
    // entangled with viem-using code; the policy package exists so that class
    // of bug is structurally impossible. The path pattern below covers both
    // the legacy and v2 SDK packages.
    // =========================================================================
    {
      name: "no-io-in-policy",
      severity: "error",
      from: {
        path: "^nodes/poly/packages/market-provider/src/policy/",
      },
      to: {
        path: [
          "^node_modules/viem",
          "^node_modules/@polymarket/clob-client/",
          "^node_modules/@polymarket/clob-client-v2/",
          "^nodes/[^/]+/(app|graphs)/",
          "^services/",
        ],
      },
      comment:
        "PURE_POLICY_NO_IO — policy modules must not import viem, " +
        "@polymarket/clob-client (any version), app/bootstrap, or any node/service code. " +
        "See docs/design/poly-positions.md § Capability A. " +
        "Path is `nodes/<X>/(app|graphs)/` so within-package imports under " +
        "`nodes/poly/packages/market-provider/src/policy/` don't false-fire (task.0421).",
    },

    // SINGLE_DOMAIN_HARD_FAIL: @cogni/poly-ai-tools is poly-domain only.
    // operator, resy, and node-template must NOT import poly-owned tools.
    // Canonical cross-node tool-import isolation (POLICY_STAYS_LOCAL — depcruise
    // rule, not a separate arch test).
    {
      name: "no-poly-ai-tools-in-non-poly-nodes",
      severity: "error",
      from: {
        path: "^nodes/(operator|resy|node-template)/",
      },
      to: {
        path: "(@cogni/poly-ai-tools|^nodes/poly/packages/ai-tools/)",
      },
      comment:
        "Poly-only tools live in @cogni/poly-ai-tools. Non-poly nodes must not import them. Add new poly tools under nodes/poly/packages/ai-tools/ only.",
    },
  ],
};
