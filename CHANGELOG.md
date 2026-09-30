# Changelog

## 1.2.0 — 2026-09-30

- Save independent provider/model/reasoning assignments for orchestrator, workers and final reviewer in Settings.
- Populate models and supported reasoning levels from DSH's native catalog; retain unavailable saved choices and drafts after discovery failure.
- Apply Web parent choices through the native Session selector and headless choices through the scoped selector; record actual routing in request headers.
- Capture worker/reviewer choices per invocation, preserve inheritance and clear inherited effort for explicit model defaults.
- Preserve model choices when staging two-worker queue defaults; save changed model fields atomically with the existing revision fence.
- Keep model changes during prompt assembly on the next request and retain isolated contexts, reviewer restrictions and the two-lane queue.
- See [UPGRADE-1.2.md](UPGRADE-1.2.md) for the volatile `subagentModel` type and native default-model behavior.

## 1.1.1 — 2026-09-30

- Add profile-backed controls for task/stream concurrency, planning mode, review, context ranges and explicit retry budgets.
- Preserve exact token counts, stage defaults, validate related fields, and save edited fields atomically with a revision fence.
- Keep Settings notices in the shell, keep drafts after refusal and use the shared DSH controls in both themes.
- Snapshot execution policy for each run; apply tighter queue admission limits without cancelling active model streams.
- Verify form save/refusal/conflict states, live mode changes, queue limit changes and responsive rendering.
- Require the parent-assigned plan and save native TODO/checkpoint before worker startup.
- Validate two independent initial tasks and mandatory final review.
- Use isolated subagent execution with actual output limits and read-only tool restrictions.
- Fix active-context admission symmetry, refill all free model lanes and preserve numeric budget diagnostics.
- Preserve partial reports, explicit missing-data resume and interrupted-run recovery; separate tasks from retry budgets.
- Pin worker output schemas and decoded reports to the parent's assigned task identity.
- Use English release documentation, status summaries and TODO reasons.
- Align CI with Node.js 24 and pnpm 12.4.1 for reproducible frozen-lockfile installs.
- See [UPGRADE-1.1.md](UPGRADE-1.1.md) for changed tool fields, configuration types and DSH compatibility.

## 1.0.8 — 2026-09-30

- Add peer ranges for DeepSeek Harness 0.2.0-rc.2 while retaining the previously supported 0.1.x ranges.
- Update development dependencies to the matching DSH 0.2.0-rc.2 APIs and Cordis 4.0.4.
- Require Schemastery 3.18.4, which types DSH 0.2 volatile config values correctly.
- Let DSH choose its profile pnpm version for Git installs and compile with the local TypeScript binary during package preparation.
- Document the compatibility range in both shipped READMEs and add a metadata regression check.

## 1.0.7 — 2026-09-23

- Use the DSH 0.1.7 typed message-source contract for durable orchestration notices.
- Expand the peer-package ranges to include DSH 0.1.7 prereleases.
- Check the package against DeepSeek Harness 0.1.7-alpha.2.

## 1.0.6 — 2026-09-17

- Add worker context tiers through 81,920 and 98,304 tokens while keeping the local profile's shared budget at 98,304.
- Admit the preferred number of workers first, then expand the ready set as completed workers release context and model capacity, up to six workers.
- Add per-context concurrency limits and deterministic dependency-report compaction before handoff or context escalation.
- Record the RTX 3090 result honestly: NInfer starts reliably with two active generations, while three- and six-generation startup reservations exceed available runtime memory; the local profile therefore remains capped at two.
- Update the paired READMEs and launcher-facing configuration guidance to match the active profile.

## 1.0.5 — 2026-09-16

- Bound NInfer model streams to a configurable two-request queue with priority aging, cancellation, and a conservative context-size guard.
- Make the parent orchestrator the only planner, add adaptive context tiers, bounded batch packing, worker `NEED_MORE_CONTEXT` escalation, and a six-worker ceiling with reviewer-as-worker semantics.
- Set the dynamic-worker profile defaults to six execution slots, two active generations, and a six-worker total ceiling.
- Add the reproducible RTX 3090 benchmark helper, measured candidate summary, and the approved implementation plan.
- Fix task-budget calculation so a missing reserve value cannot turn the worker budget into `NaN` and reject every worker.
- Clamp the preferred worker count to the effective request and deployment ceiling, including explicit one-worker runs.

## 1.0.4 — 2026-09-16

- Own the orchestrator, workflow engine, and model-facing delegation tools in one disableable `cordis:group`.
- Keep the web profile's standard delegation rows disabled so the Market off state cannot reactivate a fallback copy.
- Document the atomic plugin toggle behavior and cover the package-owned row layout in tests.

## 1.0.3 — 2026-09-16

- Enable the standard model-facing `subagent`, `subagent_fork`, `send_message`, `interrupt_agent`, and `list_agents` tools in profiles that install this bundle.
- Document the delegation tools and add coverage for the bundle's enabled tool rows.

## 1.0.2 — 2026-09-16

- Enable the sandboxed workflow engine required by the orchestrator when the bundle is mounted in the standard web profile.

## 1.0.1 — 2026-09-16

- Include the generated runtime role module in the published package so GitHub Release and npm-style tarball installs import correctly.

## 1.0.0 — 2026-09-16

- Initial public release of DSH Task Orchestrator.
- Added automatic complexity-gated planning, dependency-aware workers, and final review.
- Added the `dsh.bundle` installation manifest and bounded safety configuration.
