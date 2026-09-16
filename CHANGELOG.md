# Changelog

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
