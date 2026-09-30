# Release verification — 1.1.1

Verified on September 30, 2026 with Node.js 24.18.0, pnpm 12.4.1 and DSH `0.2.0-rc.2` dependencies.

## Automated checks

- `corepack pnpm@12.4.1 install --frozen-lockfile`: a fresh source copy installed successfully without existing dependencies or build outputs.
- `pnpm check`: TypeScript validation passed.
- `pnpm test`: 45 tests passed across six files.
- `pnpm pack`: Host code, browser settings module and declarations built successfully before packaging.
- `git diff --check`: no whitespace errors.

Runner tests cover TODO persistence before child creation, two independent workers, immediate queue refill, dependency ordering, final review, missing-data continuation, interrupted-run recovery, cancellation and retained partial reports. Worker reports must match the task identity assigned by the parent.

The runtime test uses DSH's production agent loop, the real spawn provider and native TODO events. A scripted model adapter supplies deterministic responses. It verifies separate child contexts, two simultaneous model streams, read-only tool denial, output limits and task-budget rejection. It does not establish a real local model's quality or GPU throughput.

Settings tests cover atomic saves of changed fields, exact numeric values, zero-as-unlimited context checks, invalid combinations, read-only forms, refused saves, connection errors, revision conflicts and notices after the form closes. Runtime tests also cover live planning-mode changes, tighter queue limits and preservation of active streams when limits decrease.

## Package and browser checks

The locally installed package was checked against its tarball contents. The installation retained the profile's configuration and component enablement. The Host configuration schema exposes all ten editable Settings fields. The final release package is built from the fresh source copy and includes the English guides and updated status messages.

An isolated browser preview used the real shared DSH controls and theme tokens. Chrome checks covered light and dark themes, a 760-pixel form, a 360-pixel form, the expanded concurrency table and save feedback. At 360 pixels the form had no horizontal overflow. Preview saves used test state and did not change the user's profile.

## Limits of the evidence

The full local profile's schema export reports existing errors in four standard preset components. Its overall schema export is not a passing check, even though the orchestrator's own schema was generated successfully.

The running DSH process was not restarted during local installation. A restart is required to load the updated package and its Host configuration fields. The browser preview checks the form itself; it does not establish that the existing process has reloaded the plugin.

Real local model execution, GPU memory usage, sustained load and performance comparisons remain unmeasured for this release. Earlier hardware experiments under `plans/` and `bench/` describe older deployments and do not establish 1.1.1 performance.
