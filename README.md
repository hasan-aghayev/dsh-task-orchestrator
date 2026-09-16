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
3. The scheduler starts a role only after its dependencies complete. Independent read-only roles are admitted incrementally by context tier and active-generation limits; when one role settles, the next fitting role can start without waiting for its sibling.
4. Workers return structured evidence, changed files, tests, blockers, next steps, and can request `NEED_FILE`, `NEED_HISTORY`, `NEED_MORE_CONTEXT`, `NEED_DEPENDENCY`, `NEED_BUDGET`, or `NEED_TOOL_RESULT`. Dependency reports are compacted to bounded facts before they are handed to another worker or reused for a context escalation; only `NEED_MORE_CONTEXT` triggers one bounded context escalation.
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
  hardContextTokens: 98304
  priorityAgingMs: 30000
  totalContextTokens: 98304
  contextCompactionChars: 4096
  concurrencyByContext:
    - { maxContextTokens: 8192, maxActiveGenerations: 2 }
    - { maxContextTokens: 16384, maxActiveGenerations: 2 }
    - { maxContextTokens: 24576, maxActiveGenerations: 2 }
    - { maxContextTokens: 32768, maxActiveGenerations: 2 }
    - { maxContextTokens: 49152, maxActiveGenerations: 2 }
    - { maxContextTokens: 65536, maxActiveGenerations: 1 }
    - { maxContextTokens: 81920, maxActiveGenerations: 1 }
    - { maxContextTokens: 98304, maxActiveGenerations: 1 }
  minimumVramHeadroomGiB: 0.8
  parentOrchestratorOnly: true
```

The `suggest` mode always returns a plan first. `off` disables automatic planning but keeps the explicit tool. `auto` is available for deployments that intentionally permit automatic execution.

`maxActiveGenerations` is the deployment ceiling. `concurrencyByContext` can lower it for large requests, so a small worker may use more lanes on hardware that passes the corresponding benchmark. On the current RTX 3090 profile every small-worker tier is intentionally set to two and the larger tiers to one: NInfer failed its startup memory reservation at three and six, so the profile does not claim unsafe parallelism. A stream holds a lane only while its output is consumed; an agent waiting for tools or children does not hold one. Completed streams release their context budget immediately, so a queued worker can replace them while another active worker continues. The parent orchestrator starts with `preferredWorkers`, then admits additional ready workers as results free capacity, up to six. `contextCompactionChars` bounds dependency reports before escalation or handoff. `priorityAgingMs` raises a waiting request by one priority level after the configured interval, so a long-running worker cannot wait forever. `hardContextTokens` is a conservative pre-tokenization guard; NInfer remains authoritative for exact token counts. `totalContextTokens` is a conservative active-work budget, not a promise that requests fit concurrently in GPU memory. `minimumVramHeadroomGiB` documents the safety target used when selecting a deployment profile.

The package defaults are conservative (`maxActiveGenerations: 2` and two lanes for small requests). To test higher small-worker concurrency, raise the global ceiling and provide matching `concurrencyByContext` entries in the deployment profile only after a benchmark on that hardware.

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
- Context tiers are 8K, 16K, 24K, 32K, 49K, 65K, 81K and 96K. The local profile keeps the shared budget at 98,304 tokens and applies a two-stream safety ceiling after the RTX 3090 reservation benchmark; higher per-tier concurrency values require a separate hardware benchmark.
- Compaction is deterministic and bounded. It preserves the report fields needed for scheduling and review, but it is not a semantic summary and does not prove that NInfer restored a KV cache after a restart.

## Repository

Source: <https://github.com/hasan-aghayev/dsh-task-orchestrator>
