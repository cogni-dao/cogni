# Actual-template acceptance

The focused `crossplane-xcomputeworkload.spec.ts` suite always runs this module
against the committed Composition. It requires a Go **1.21 or newer bootstrap** on
PATH, plus the repository's existing Node/pnpm dependencies. A C compiler, Docker
and cluster credentials are unnecessary.

The existing CI unit job uses `ubuntu-latest`. Its
[Go toolset](https://github.com/actions/runner-images/blob/main/images/ubuntu/toolsets/toolset-2404.json)
and [toolset configuration](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/Configure-Toolset.ps1)
provide that bootstrap on PATH. Its Go version is **not** the test compiler:
[native GOTOOLCHAIN selection](https://go.dev/doc/toolchain) enforces the exact
`toolchain` version declared in this module's `go.mod`. Setup checks its
`GOVERSION` and resolves its executable through native `go env GOROOT`.

The suite's setup hook uses a fresh temporary module/build cache and an explicit
environment (`GOENV=off`, `GOWORK=off`, module mode, CGO disabled). It allows HTTPS
to `proxy.golang.org`, `sum.golang.org` and their download redirects for native
toolchain provisioning and `go mod download`, then runs `go mod verify`. Each
setup command has a 90-second timeout; the whole setup is bounded to 280 seconds.
Missing Go, unavailable downloads, verification errors or changes to committed
`go.mod`/`go.sum` fail the suite.

Only after setup succeeds, both cold and warm **build-cache** assertions execute
the resolved compiler's `go test -mod=readonly -count=1 -v .` with
`GOTOOLCHAIN=local`, `GOPROXY=off` and `GOSUMDB=off`. Direct execution avoids
re-entering a bootstrap that needs checksum verification even for a cached
toolchain.
Neither assertion can fetch modules or a toolchain. Both execute all fixture
cases; `-count=1` prevents Go test-result caching. Module caches start empty on
every suite invocation. Cleanup uses native `go clean -modcache` before removing
the temporary directory.

Run through the existing focused suite:

```sh
pnpm exec vitest run tests/ci-invariants/crossplane-xcomputeworkload.spec.ts
```

A bare `go test` does not provide this setup/offline boundary. The suite inherits
no ambient Go workspace, saved Go configuration, module cache, compiler flags,
platform overrides or private-proxy settings.
