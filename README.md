# DSH Task Orchestrator

Adaptive delegation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The parent model remains the only orchestrator: it creates or validates a small dependency graph, selects the minimum useful number of workers, packs them by context budget, and may assign review to one ordinary worker slot.

Author: Hasan Aghayev  
License: MIT

## Install

Install the public GitHub package into a DSH profile:

```sh
pnpm dsh plugin --profile web add https://github.com/hasan-aghayev/dsh-task-orchestrator.git
```

The package declares a `dsh.bundle` manifest in `package.json`, so the command can discover and apply `cordis.patch.yml` automatically. Its bundle installs one package-owned delegation group containing the workflow engine and the model-facing surface: `subagent`, `subagent_fork`, `send_message`, `interrupt_agent`, and `list_agents`. It does not enable DSH's separate model-facing `workflow` tool. The standard web-profile rows stay disabled, so disabling this plugin in DSH Market disables the group and all of these tools together. Remove it with:

```sh
pnpm dsh plugin --profile web remove dsh-task-orchestrator
```

Restart the profile after installation if it is already running.

## What it does

The plugin adds the `task_orchestrate` tool and enables the standard DSH delegation tools. A simple request stays on the normal path. A complex request is scored with a deterministic detector and then sent through these stages:

1. The parent orchestrator supplies a strict JSON plan, or the plugin creates a minimal deterministic graph without a planner child.
2. Each worker receives only an explicit `TASK`, `GOAL`, `RELEVANT CONTEXT`, `CONSTRAINTS`, `KNOWN FACTS`, `FILES / CODE`, `DEPENDENCIES`, `EXPECTED OUTPUT`, and `DO NOT` packet.
3. The scheduler starts a role only after its dependencies complete. Independent read-only roles are packed into safe batches by context tier and active-generation limits.
4. Workers return structured evidence, changed files, tests, blockers, next steps, and can request `NEED_FILE`, `NEED_HISTORY`, `NEED_MORE_CONTEXT`, `NEED_DEPENDENCY`, `NEED_BUDGET`, or `NEED_TOOL_RESULT`; only `NEED_MORE_CONTEXT` triggers one bounded context escalation.
5. A task with role `reviewer` is an ordinary worker and produces the final review fields; no seventh child is created.

Supported roles are `researcher`, `architect`, `backend`, `frontend`, `tester`, `documentation`, and `reviewer`. The plugin uses the existing DSH subagent and workflow services and does not modify the agent loop.

The model can also call `subagent` for a fresh child, `subagent_fork` for a child that inherits completed parent turns, and `list_agents`, `send_message`, or `interrupt_agent` to manage continuable children. These tools are package-owned group children rather than edits to the base rows. That ownership makes the Market toggle atomic: plugin off means the group and all five model-facing tools are off, while the web profile's standard rows remain off as well.

## Safe defaults

The default mode is `hybrid`:

- simple requests do not start child agents;
- complex read-only requests can run automatically;
- plans that require writes stop at `plan-only` until a human approves them;
- writes and parallel writes are disabled by default;
- workers require a fresh structured-output subagent provider;
- at most six workers can exist in one orchestration; the parent is not counted as a child, so the logical maximum is one parent plus six workers;
- oversized plans, reports, and parent notices are rejected or truncated at configured limits.

Automatic write execution should be enabled only in a profile that has its own approval and workspace policy:

```yaml
config:
  mode: hybrid
  minComplexityScore: 55
  subagentProvider: spawn
  preferredWorkers: 2
  maxWorkers: 6
  maxTotalAgents: 6
  maxConcurrentAgents: 2
  allowWrites: false
  allowParallelWrites: false
  requireReview: true
  maxActiveGenerations: 2
  hardContextTokens: 65536
  priorityAgingMs: 30000
  totalContextTokens: 98304
  minimumVramHeadroomGiB: 0.8
  parentOrchestratorOnly: true
```

The `suggest` mode always returns a plan first. `off` disables automatic planning but keeps the explicit tool. `auto` is available for deployments that intentionally permit automatic execution.

`maxActiveGenerations` limits consumed model streams across the parent and children. A stream holds a lane only while its output is consumed; an agent waiting for tools or children does not hold one. `priorityAgingMs` raises a waiting request by one priority level after the configured interval, so a long-running worker cannot wait forever. `hardContextTokens` is a conservative pre-tokenization guard; NInfer remains authoritative for exact token counts. `totalContextTokens` is a conservative batch budget, not a promise that requests fit concurrently in GPU memory. `minimumVramHeadroomGiB` documents the safety target used when selecting a deployment profile.

The `task_orchestrate` tool accepts `objective`, optional parent-created `plan`, optional `planOnly`, optional `executeWrites`, and an optional `maxWorkers` cap. A request-side cap can never exceed the configured deployment ceiling.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The package emits JavaScript to `lib/` and declaration files to `lib/types/`. The published package contains only the built runtime, declarations, bundle patch, and paired READMEs.

## Limitations

- Workers share the profile workspace. Parallel writes remain disabled by default and the plugin does not create automatic git worktrees.
- Complexity detection uses lexical signals and may miss a short difficult request or classify a long simple request as complex.
- NInfer does not force arbitrary JSON output by itself. DSH validates plan and worker fields after each model response, but that validation does not replace human review.
- Write scopes are declared to the scheduler and worker prompts; the surrounding DSH profile remains responsible for filesystem permissions and approval policy.

## Repository

Source: <https://github.com/hasan-aghayev/dsh-task-orchestrator>
