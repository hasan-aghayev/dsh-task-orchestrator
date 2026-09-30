# Upgrade to 1.2.0

Version 1.2.0 adds saved provider, model and reasoning choices for the orchestrator, workers and reviewer. It retains the TODO-first queue and DSH `0.2.0-rc.2` compatibility of 1.1.1. Read [UPGRADE-1.1.md](UPGRADE-1.1.md) as well when upgrading from 1.0.x.

## Saved assignments

Open **Settings → Task Orchestrator → Models and reasoning**. Choose a model for each role, select one of its advertised reasoning levels or **Model default**, and Save. Unassigned workers inherit the parent; an unassigned reviewer inherits the worker selection. Unassigned parent routing preserves the current chat model. Settings updates do not restart active model streams.

Parent and reviewer assignments require both registered LLM provider and model. Existing model-only `subagentModel` remains valid and inherits the parent's provider. `subagentLlmProvider` is the new worker LLM provider field; keep `subagentProvider: spawn` for fresh child execution. Effort fields are `orchestratorReasoningEffort`, `subagentReasoningEffort` and `reviewerReasoningEffort`. Empty effort uses the model default for an explicit assignment; it does not copy the parent's explicit effort.

Web parent assignments use the native Session model selector, which also saves DSH's default model. They apply before the first request of a newly active parent and after saved parent settings change. A subsequent chat selection remains available. Headless parents use the scoped DSH selector. Worker/reviewer choices are captured once per invocation or explicit resume; queued children in that invocation retain those choices.

## Typed consumers and package update

`subagentModel` and the eight new role fields are volatile in the plugin's resolved `Config`. TypeScript consumers must read them through `.get()`. Plain YAML field values and `ConfigValues` remain ordinary strings. Code that constructed a resolved `Config` directly must supply volatile wrappers or pass through Cordis's configuration resolver.

The optional `@deepseek-ai/dsh-api-session-controller` peer provides native Web selection; headless operation does not require that service. The client Settings page uses the Web profile's `@deepseek-ai/dsh-api-remotes` model catalog. Model assignments do not add provider credentials, start local model servers or increase tool permissions.

Install the 1.2.0 package and restart DSH to load the new Host schema and browser module. Preserve the previous package and profile settings for rollback. To return to 1.1.x, remove the new role fields and retain only any legacy `subagentModel`; 1.1.x cannot honor the three-role routing policy.
