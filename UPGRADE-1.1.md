# Upgrade to 1.1.1

Version 1.1.1 includes the TODO-first execution changes and expanded Settings controls. It targets the DSH 0.2 API line and is tested against `0.2.0-rc.2`. Read these changes before replacing a 1.0.x installation.

## Execution and compatibility

- `task_orchestrate.plan` is now required. Each task needs a unique `owner`. Parent prompts or custom callers must supply the graph; keyword-generated fallback execution has been removed.
- Default plans require two independent initial tasks and one final reviewer. Keep at least three logical task slots, or explicitly change `minParallelTasks`/`requireReview` for a different deployment. A missing required reviewer is rejected before any child starts.
- `maxTotalAgents` caps logical tasks, including review. Configure `maxChildStarts` and `maxAttemptsPerTask` for explicit retries. The default local model limit remains two actual streams, including the parent; large contexts can run alone.
- Only fresh providers supporting structured output, tool restrictions and agent-option overrides are accepted. The verified local route is `spawn`. Output reserves are real model response limits. Local task context limits include output and safety reserves.
- Missing-data requests return to the parent. Resume with `runId` and new `resumeContext`, or correct an unfinished task packet/budget. The plugin preserves completed evidence and does not blindly increase context and rerun.
- Checkpoint metadata is additive JSON inside native `todo/write` data. Existing readers retain the normal `todos` projection. Removing the plugin keeps the native TODO and conversation readable. Legacy 1.0.x runs without checkpoint metadata cannot be resumed through the new runner.
- Required planning is enforced before implementation for requests selected by the complexity policy. After the configured finite reminders, an unsaved plan reports an error instead of silently finishing. Short questions retain the ordinary path.
- `minimumVramHeadroomGiB` is removed: the plugin did not measure free VRAM. Context estimates and concurrency tiers remain configurable. `parentOrchestratorOnly` must remain true.
- The package narrows peer declarations to the DSH 0.2 API line. Update DSH first if the profile uses 0.1.x. Install the new plugin package and restart DSH to load its Host configuration schema. Keep a copy of the previous package and profile settings if a rollback is needed.

## Settings and typed configuration

The Settings form now projects mode, maxWorkers, maxConcurrentAgents, requireReview, maxActiveGenerations, concurrencyByContext, maxChildStarts and maxAttemptsPerTask as volatile fields alongside both context budgets. Profile field names, plain YAML values and defaults remain unchanged. TypeScript consumers reading the plugin Config directly must read these values through `.get()`; `ConfigValues` describes plain profile inputs.

New runs snapshot the saved task policy. Request/global limits remain live, and queued requests are rejected when updated context limits cannot admit them. Active provider streams are not cancelled by lowering a limit. Existing `auto` mode remains supported; the default selector offers hybrid, suggest and manual modes because auto shares hybrid execution semantics.

Status summaries and TODO reasons emitted by this version use English. Previously saved text remains in the session history. Release documentation is English; `SCENARIO.md` replaces `SCENARIO.ru.md`, and the translated README is no longer shipped.

See the [usage guide](SCENARIO.md) for Settings and a complete tool example, and the [verification report](VERIFICATION.md) for tested behavior and remaining gaps.
