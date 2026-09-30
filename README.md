# DSH Task Orchestrator

[Usage guide](SCENARIO.md) · [Upgrade to 1.2](UPGRADE-1.2.md) · [Upgrade from 1.0](UPGRADE-1.1.md) · [Release verification](VERIFICATION.md)

The parent model writes and assigns a TODO plan before starting isolated workers. Independent work uses up to two model streams by default; additional tasks wait in a dependency-aware queue. The parent receives structured results, missing-data requests and a final review. Short questions use the ordinary single-agent path.

Author: Hasan Aghayev · License: MIT

## Execution

1. For substantial work, the parent supplies an explicit `plan` to `task_orchestrate`. Every task has a unique `id` and `owner`, a goal, role, dependencies and read/write policy. At least two initial worker tasks must be independent. A required reviewer depends on every worker and occupies an ordinary task slot.
2. The plugin validates the complete graph and writes native TODO before creating the first child. Short questions need no team. The complexity detector adds planning instructions; it never constructs or executes a graph from keywords.
3. Ready tasks run through fresh `spawn` contexts. Children receive only their assigned packet, compacted dependency reports and any explicitly supplied additional data. Read-only children receive a real tool allow-list. Output reserves become the child's `maxTokens` setting.
4. At most two logical children run at once by default. One child's settlement immediately opens a slot for the next ready task. A separate shared scheduler counts actual model streams, including the parent. Limits of both incoming and already active requests apply. Large contexts may run alone. Aged waiting requests can reserve capacity so smaller newcomers do not indefinitely bypass them.
5. Each native `todo/write` snapshot contains the TODO list plus versioned plugin checkpoint metadata. The checkpoint retains assignments, attempts, child identities, reports and reasons. Completed tasks remain completed when resuming; a crash-interrupted child is marked waiting and is not duplicated if still live.
6. `NEED_FILE`, `NEED_HISTORY`, `NEED_BUDGET` and other needs return to the parent. No automatic retry occurs without new data or an explicitly corrected unfinished task packet/budget. A run becomes completed only when every task succeeds and required review approves it.

## Installation

Version 1.2.0 targets the DSH 0.2 API line and is tested against `0.2.0-rc.2`. Install the versioned release package into a DSH profile:

```sh
dsh plugin --profile web add https://github.com/hasan-aghayev/dsh-task-orchestrator/releases/download/v1.2.0/dsh-task-orchestrator-1.2.0.tgz
```

Use your profile name in place of `web`. The same command accepts a locally built tarball. To install the latest source from the default branch, use:

```sh
dsh plugin --profile web add https://github.com/hasan-aghayev/dsh-task-orchestrator.git
```

`cordis.patch.yml` supplies the `task-orchestrator-suite` group and companion delegation tools. The orchestrator uses the subagent service directly; the companion workflow component is not its execution engine. Configuration and component enablement remain owned by the profile. Enable the suite and orchestrator in Plugins if they are disabled. Restart DSH after updating the installed package so the Host loads the new configuration fields.

## Configuration

```yaml
config:
  mode: hybrid
  subagentProvider: spawn
  minParallelTasks: 2
  preferredWorkers: 2
  maxWorkers: 6
  maxTotalAgents: 6
  maxConcurrentAgents: 2
  maxActiveGenerations: 2
  maxChildStarts: 12
  maxAttemptsPerTask: 2
  requireReview: true
  allowWrites: false
  allowParallelWrites: false
  hardContextTokens: 65536
  totalContextTokens: 98304
  contextCompactionChars: 4096
  maxPlanningReminders: 2
  scheduledProviders: []
```

`maxWorkers` and `maxTotalAgents` cap logical tasks, including review. `maxChildStarts` separately caps starts and explicit retries. `preferredWorkers` is planning guidance; `minParallelTasks` validates the independent initial task count. Different useful outputs are the parent's responsibility.

The default `concurrencyByContext` permits two streams through 49,152 estimated input tokens and one above that size, through 150,000. The smallest active request's concurrency ceiling also applies to newcomers. `hardContextTokens` guards estimated input; `totalContextTokens` counts estimated input, reserved output and safety across active streams. Each local orchestration child additionally has its assigned whole-request `contextBudget`. When request options omit maxTokens, defaultOutputReserveTokens reserves 2,048 output tokens; requestSafetyReserveTokens reserves 1,024 additional tokens for requests without a task-specific reserve. These estimates do not measure VRAM or replace the provider's tokenizer.

An empty `scheduledProviders` list schedules every LLM route in this process. Set it to the local provider's registered name to keep cloud routes outside the local shared queue. Children still retain their task-level output limit. Hard child context checks require in-process `spawn` execution; a remote runtime needs its own corresponding resource policy.

`mode: off` disables automatic planning instructions and guards but retains the explicit tool. `suggest` asks for a saved plan first; existing human authorization permits execution. `hybrid` and `auto` instruct the parent to plan and execute substantial work within existing authorization. Plans requesting confirmation, and unauthorized write tasks, return `plan-only`. A bounded reminder policy reports failure if a required plan is never saved.

The web **Settings → Task Orchestrator** page edits models and reasoning for all three roles, planning mode, active task slots, logical task count, final review, shared model streams and both context budgets. Advanced controls edit context/concurrency ranges, total child starts and starts per task. Numeric context inputs preserve exact saved values; sliders use 1,024-token steps. Zero disables that global context check, while task budgets and concurrency limits still apply. Conflicting combinations disable Save. The defaults action stages the two-worker settings without saving them automatically and preserves model assignments.

One atomic, revision-fenced Save changes only edited fields in the profile. A refusal keeps the draft; a newer Host revision requires Reload. Outcome notices live in the shell and survive closing Settings. New task runs snapshot their execution policy; active runs keep that policy. Model streams read current request limits. Queued requests honor the latest shared/global limits and tighter context ceilings; lowering a limit does not cancel active streams. Updating the installed plugin package requires restarting DSH to load the new Host schema.

## Models and reasoning

Choose **Orchestrator model**, **Worker model** and **Reviewer model** in Settings, then choose each model's reasoning level and Save. Models are grouped by their registered LLM provider. Levels come from DSH's model catalog; there is no fixed list of efforts and no reasoning control for models that do not advertise adjustable reasoning. Changing a model clears its previous effort. **Model default** omits an explicit effort, allowing the selected model's provider default.

| Role | Model fields | Reasoning field | Inheritance when no model is assigned |
| --- | --- | --- | --- |
| Orchestrator | `orchestratorProvider`, `orchestratorModel` | `orchestratorReasoningEffort` | Keep the current chat selection and reasoning. |
| Workers | `subagentLlmProvider`, `subagentModel` | `subagentReasoningEffort` | Inherit the parent's effective selection and reasoning. |
| Reviewer | `reviewerProvider`, `reviewerModel` | `reviewerReasoningEffort` | Inherit the worker selection and reasoning. |

These are plain strings in profile YAML. Empty strings mean inheritance for model/provider fields and the model default for an explicitly assigned model's effort. A parent or reviewer assignment requires both provider and model. Legacy `subagentModel` without `subagentLlmProvider` remains supported and inherits the parent's provider. `subagentProvider: spawn` chooses the child execution service, while `subagentLlmProvider` chooses the LLM route.

The Web parent uses DSH's native model selector before prompt assembly. A saved parent assignment applies to a newly active parent and after its model/effort settings change; an explicit later chat selection remains available. The native selector records the selection in the Session and also updates DSH's default model for future chats. Clearing the saved assignment preserves the current chat choice. Headless profiles use DSH's scoped model-selection helper. Both paths keep prompt model information and actual request routing consistent, including changes made during asynchronous assembly.

Worker and reviewer selections are captured once per tool invocation, including an explicit resume. Active children and remaining queued tasks in that invocation keep the captured selections. An explicit assignment without an effort clears inherited reasoning even when it names the same model as the parent. Actual request headers record provider, model and resolved effort. Unavailable or unsupported choices fail through DSH's validation; the plugin does not silently substitute a model.

**Refresh models** reloads the native catalog. Discovery failures retain saved choices and other staged edits. A stored unavailable assignment remains visible and can be cleared; unrelated queue settings can still be saved. The form validates newly edited assignments against the successfully loaded catalog. Models must already be configured in the DSH profile; assigning one here does not install or load a local model server.

## Tool fields

`task_orchestrate` requires `objective` and `plan`. A plan contains `summary`, `risk` (`low`, `medium` or `high`), `requiresConfirmation` and `tasks`. Optional tool fields are `planOnly`, `executeWrites`, `maxWorkers`, `runId` and `resumeContext`. `executeWrites` must reflect existing human authorization, not create it. See the [complete read-only example](SCENARIO.md#example-plan).

Every plan task requires `id`, `title`, `owner`, `role`, `prompt`, `dependsOn`, `readOnly` and `writeScopes`. Optional `taskPackage` carries relevant context, facts, files, constraints and expected output. Defaults are `contextBudget: 24576`, `outputReserveTokens: 2048`, `safetyReserveTokens: 1024`. Supported roles: researcher, architect, backend, frontend, tester, documentation, reviewer.

Resume the returned `runId` with `resumeContext: { taskId: "new information" }`. You may also revise the budget or packet of an unfinished task. Assignment, goal, dependencies and write permissions must stay identical; completed task inputs cannot change while reusing their evidence. A task blocked solely by dependencies becomes ready after they succeed. Partial results remain recorded on errors and cancellation.

Native TODO uses its three statuses: queued/waiting/failed tasks remain pending with a reason, active tasks are in progress, successful tasks are completed. Full task states and reports live in the same saved event. Parent-facing text and complete dependency excerpts are bounded by configuration; full checkpoint data remains available in the session log.

## Development and verification

```sh
corepack pnpm@12.4.1 install --frozen-lockfile
corepack pnpm@12.4.1 check
corepack pnpm@12.4.1 test
corepack pnpm@12.4.1 build
corepack pnpm@12.4.1 pack
```

The development and CI environment uses Node.js 24 and pnpm 12.4.1. Runtime requires Node.js 22.19 or later. The package does not pin the profile's package manager; DSH manages profile installation.

Tests control child settlement with barriers and exercise the shipped DSH production loop, real spawn provider, native TODO and a scripted model adapter. They verify separate provider/model/effort assignments, logged routing, context isolation, two active lanes, queue refill, read-only denial, output limits, hard task-budget rejection, missing-data resume, interrupted-run recovery, cancellation and reviewer approval. The scripted adapter does not establish a real local model's reliability or hardware throughput.

Host JavaScript and the browser settings module are built into `lib/`; declarations are in `lib/types/`. The [verification report](VERIFICATION.md) records the checks and their limits. Read [the upgrade guide](UPGRADE-1.1.md) before replacing a 1.0.x installation.

## Limits

Workers share a workspace; the plugin does not create worktrees. Declared write scopes prevent overlapping declared writers and guide prompts, while filesystem permissions remain the profile's responsibility. Parallel writes are disabled by default. Read-only enforcement depends on the configured read-tool allow-list. The lexical detector can miss a short difficult request; the parent can explicitly invoke the tool. Report compaction is bounded text, not a semantic summary. The plugin does not monitor GPU memory.
