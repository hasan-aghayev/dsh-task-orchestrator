# Usage guide — version 1.2.0

The parent agent plans the work, assigns tasks, receives worker results and answers the user. A worker is a separate agent with its own conversation context. By default, two workers can perform independent work together; other tasks wait until their dependencies are complete and capacity is available.

## Normal workflow

1. The parent prepares a TODO list with a goal, named owner and dependencies for every task. The plugin validates and saves this list before starting any worker.
2. Two initial workers do different useful jobs. For example, one inspects the implementation while the other checks tests and constraints. Short questions do not need a team.
3. A finished worker releases its slot immediately. The next ready task can start while its sibling continues working.
4. Each worker receives its assigned information and relevant dependency reports. The parent conversation is not copied wholesale into every worker.
5. A worker that lacks a file, history or budget reports precisely what it needs. The parent obtains the information and resumes that task explicitly. Completed tasks keep their evidence and are not rerun.
6. The final reviewer checks every worker's results. With the default settings, a run cannot become completed until all tasks succeed and the reviewer approves them.

The native TODO list shows owners and waiting reasons. Failed or waiting tasks remain unfinished. The saved checkpoint also retains reports, attempt counts and child identities. After an interrupted run, unfinished work requires explicit continuation; a child that is still running is not duplicated.

## Recommended local settings

| Setting | Default | Effect |
| --- | --- | --- |
| Planning mode | `hybrid` | Plan and execute substantial work within the user's existing authorization. |
| Active task slots | 2 | Start at most two logical child agents together. |
| Logical task limit | 6 | Include the final reviewer in this limit. |
| Final review | Required | Require approval before completing the run. |
| Shared model streams | 2 | Count actual model requests, including the parent. |
| Per-request input limit | 65,536 tokens | Reject a request whose estimated input exceeds this limit. |
| Shared active budget | 98,304 tokens | Count estimated input, reserved output and safety across active requests. |
| Child starts per run | 12 | Bound all starts, including explicit retries and review. |
| Starts per task | 2 | Bound explicit attempts for one logical task. |

Tokens are the units of text processed by a model. Estimates help decide when a request can start; they do not measure GPU memory. Large contexts may reduce parallel execution to one request. Waiting for tools or worker results does not consume a model stream.

If the profile also uses cloud models, configure `scheduledProviders` with the local provider's registered name. The empty default schedules every model route in this process. Task-level output limits still apply to orchestration children outside that shared queue.

## Settings page

Open **Settings → Task Orchestrator**. **Models and reasoning** contains separate model and effort controls for the orchestrator, workers and reviewer. The other controls edit planning mode, task slots, logical task count, review, model streams and context budgets. **Advanced** contains the context/concurrency table and retry limits.

Choose a model already registered in your profile, then choose a reasoning level supported by that model. **Model default** lets the model use its provider default. A model without adjustable reasoning has a disabled reasoning field. Changing a model clears the previous effort. With inheritance selected, workers use the parent's effective model and reasoning, and the reviewer uses the worker selection. Every worker and reviewer still has a separate context, even if they use the same model.

The saved Web orchestrator model applies before a newly active parent's first request and after its model settings change. You can subsequently switch models in the chat. DSH's native selector also updates the default for future chats. Worker/reviewer choices are captured per tool invocation or explicit resume; active and queued tasks in that invocation keep them. **Refresh models** retries discovery without discarding staged settings. An unavailable saved choice remains visible until you replace or clear it.

Context limits accept exact numeric input; sliders move in 1,024-token steps. Zero removes the corresponding global context check, while task budgets, concurrency limits and the model's own context window still apply. **Use two-worker defaults** stages the recommended queue values while preserving your model choices. Press **Save** to persist them.

Save changes only edited fields in one operation. Invalid combinations cannot be saved. If another window has changed the profile, use **Reload** before saving again. Refused or failed saves retain the draft, and outcome messages remain visible after Settings closes.

New runs read the saved task policy; an active run keeps the policy it started with. Model admission reads current limits. Lowering a limit does not cancel an active stream, but queued requests must fit the updated limits. Restart DSH after updating the plugin package to load its new configuration fields.

## Example plan

This read-only audit has two independent initial tasks and a final reviewer. Pass this JSON as the `task_orchestrate` tool arguments; the parent supplies the real project objective and prompts.

```json
{
  "objective": "Assess the project's implementation and test coverage.",
  "plan": {
    "summary": "Inspect implementation and tests independently, then review the combined findings.",
    "risk": "low",
    "requiresConfirmation": false,
    "tasks": [
      {
        "id": "implementation",
        "title": "Inspect the implementation",
        "owner": "implementation-worker",
        "role": "researcher",
        "prompt": "Read the relevant source files and report the main behavior, defects and supporting evidence.",
        "dependsOn": [],
        "readOnly": true,
        "writeScopes": []
      },
      {
        "id": "coverage",
        "title": "Inspect test coverage",
        "owner": "coverage-worker",
        "role": "tester",
        "prompt": "Read the existing tests and report which important behaviors lack coverage. Do not run write-capable tools.",
        "dependsOn": [],
        "readOnly": true,
        "writeScopes": []
      },
      {
        "id": "review",
        "title": "Review the combined findings",
        "owner": "final-reviewer",
        "role": "reviewer",
        "prompt": "Check both reports for evidence, omissions and contradictions, then approve or request changes.",
        "dependsOn": ["implementation", "coverage"],
        "readOnly": true,
        "writeScopes": []
      }
    ]
  }
}
```

Add `planOnly: true` when the user requested a plan without execution. An implementation task uses `readOnly: false` and declared `writeScopes`; `executeWrites: true` is valid only when the user has already authorized implementation. Profile permissions still control file access. Declared scopes are not an operating-system filesystem restriction, and workers share the same workspace.

Resume a returned `runId` with the same objective and assignments, adding `resumeContext: { "task-id": "new information" }` or correcting an unfinished task's information packet or budget. The plugin does not retry blindly or silently expand context limits.

For compatibility changes and verification limits, read the [1.2 upgrade guide](UPGRADE-1.2.md), the [1.0 migration guide](UPGRADE-1.1.md) and [verification report](VERIFICATION.md).
