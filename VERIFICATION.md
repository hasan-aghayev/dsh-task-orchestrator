# Release verification — 1.2.0

Verified on September 30, 2026 with Node.js 24.18.0, pnpm 12.4.1 and DSH `0.2.0-rc.2` dependencies.

## Automated checks

- `corepack pnpm@12.4.1 install --frozen-lockfile`: a fresh source copy installed successfully without existing dependencies or build outputs.
- `pnpm check`: TypeScript validation passed.
- `pnpm test`: 54 tests passed across seven files.
- `pnpm pack`: Host code, browser settings module and declarations built successfully before packaging.
- `git diff --check`: no whitespace errors.

Runner tests cover TODO persistence before child creation, two independent workers, immediate queue refill, dependency ordering, final review, missing-data continuation, interrupted-run recovery, cancellation and retained partial reports. Worker reports must match the task identity assigned by the parent.

The runtime test uses DSH's production agent loop, the real spawn provider and native TODO events. A scripted model adapter supplies deterministic responses. It verifies different provider/model/reasoning selections for parent, workers and reviewer, recorded request headers, separate child contexts, two simultaneous model streams, read-only tool denial, output limits and task-budget rejection. It does not establish a real local model's quality or GPU throughput.

Role-policy tests exercise inheritance, independent reviewer choices, explicit model defaults without inherited effort, legacy model-only worker assignment and incomplete configuration rejection. A production-loop test uses a prompt-assembly barrier to verify that a concurrent choice change affects the next request and records the model-change notice. Native-selector seam tests verify calls, change detection, child exclusion and refusal before assembly using a controlled selector; they do not exercise a complete live Web Session controller.

Settings tests cover atomic saves of three model/effort assignments, available reasoning levels, clearing effort on a model change, retained unavailable choices, discovery failure and retry, preserved model choices when staging queue defaults, exact numeric values, invalid combinations, read-only forms, refused saves, connection errors, revision conflicts and notices after the form closes. Runtime tests also cover live planning-mode changes, tighter queue limits and preservation of active streams when limits decrease.

## Package and browser checks

The locally installed package was checked against its tarball contents. The installation retained the profile's configuration and component enablement. The Host configuration schema exposes the ten queue/context fields and nine role model fields. The final release package is built from the fresh source copy and includes the English usage, migration and verification guides.

An isolated browser preview used the real shared DSH controls and theme tokens. Chrome checks covered light and dark themes, a 760-pixel form, a 360-pixel form, three role model/effort selectors and save feedback. At 360 pixels the form had no horizontal overflow. Preview saves and the model catalog used test state and did not change the user's profile. Earlier 1.1.1 checks also covered the unchanged expanded concurrency table.

## Limits of the evidence

The full local profile's schema export reports existing errors in four standard preset components. Its overall schema export is not a passing check, even though the orchestrator's own schema was generated successfully.

The running DSH process was not restarted during local installation. A restart is required to load the updated package and its Host configuration fields. The browser preview checks the form itself; it does not establish that the existing process has reloaded the plugin.

Real local model execution, GPU memory usage, sustained load and performance comparisons remain unmeasured for this release. Earlier hardware experiments under `plans/` and `bench/` describe older deployments and do not establish 1.2.0 performance.
