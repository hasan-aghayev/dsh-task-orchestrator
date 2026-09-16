# Changelog

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
