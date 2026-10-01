/** Profile model assignments and native parent selection. @module */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'

/** Persisted model and effort fields for the three orchestration roles. */
export interface RoleModelValues {
  /** Registered LLM provider for the parent; empty preserves the chat selection. */
  orchestratorProvider?: string
  /** Parent model id on that provider. */
  orchestratorModel?: string
  /** Parent reasoning effort; empty uses the selected model's default. */
  orchestratorReasoningEffort?: string
  /** Registered LLM provider for workers; distinct from the spawn transport. */
  subagentLlmProvider?: string
  /** Worker model id; legacy model-only settings inherit the parent's provider. */
  subagentModel?: string
  /** Worker reasoning effort; empty uses the selected model's default. */
  subagentReasoningEffort?: string
  /** Registered LLM provider for the final reviewer. */
  reviewerProvider?: string
  /** Reviewer model id; empty inherits the worker assignment. */
  reviewerModel?: string
  /** Reviewer reasoning effort; empty uses the selected model's default. */
  reviewerReasoningEffort?: string
}

/** Model fields that can be edited without unloading active workers. */
export const ROLE_MODEL_FIELDS = ['orchestratorProvider', 'orchestratorModel', 'orchestratorReasoningEffort',
  'subagentLlmProvider', 'subagentModel', 'subagentReasoningEffort', 'reviewerProvider', 'reviewerModel', 'reviewerReasoningEffort'] as const

/** An explicit assignment, or a legacy worker model that inherits its provider. */
export interface ModelAssignment {
  provider?: string
  model: string
  reasoningEffort?: ModelSelection['reasoningEffort']
}

/** Validated configured assignments; absence preserves the corresponding inherited selection. */
export interface RoleModels {
  orchestrator?: ModelSelection
  worker?: ModelAssignment
  reviewer?: ModelSelection
}

/** Resolve plain profile fields and reject incomplete assignments before execution.
 * @param values - current profile values.
 * @returns validated role assignments.
 */
export function resolveRoleModels(values: RoleModelValues): RoleModels {
  const read = (provider: string, model: string, effort: string, legacy = false): ModelAssignment | undefined => {
    if (!model) {
      if (provider || effort) throw new TypeError('Choose a model before assigning its provider or reasoning effort')
      return undefined
    }
    if (!provider && !legacy) throw new TypeError('A model assignment needs its registered LLM provider')
    if ([provider, model, effort].some(value => value !== value.trim())) throw new TypeError('Model assignments cannot contain leading or trailing whitespace')
    return { ...(provider ? { provider } : {}), model, ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}) }
  }
  const parent = read(values.orchestratorProvider ?? '', values.orchestratorModel ?? '', values.orchestratorReasoningEffort ?? '')
  const worker = read(values.subagentLlmProvider ?? '', values.subagentModel ?? '', values.subagentReasoningEffort ?? '', true)
  const reviewer = read(values.reviewerProvider ?? '', values.reviewerModel ?? '', values.reviewerReasoningEffort ?? '')
  return {
    ...(parent === undefined ? {} : { orchestrator: { ...parent, provider: parent.provider! } }),
    ...(worker === undefined ? {} : { worker }),
    ...(reviewer === undefined ? {} : { reviewer: { ...reviewer, provider: reviewer.provider! } }),
  }
}

/** Resolve worker inheritance once for a run and keep its reviewer assignment independent.
 * @param configured - configured role assignments.
 * @param inherited - the parent's effective provider/model and explicitly owned effort.
 * @returns complete worker and reviewer selections.
 */
export function resolveChildModels(configured: RoleModels, inherited: ModelSelection): { worker: ModelSelection; reviewer: ModelSelection } {
  const worker = configured.worker === undefined ? { ...inherited } : {
    provider: configured.worker.provider ?? inherited.provider,
    model: configured.worker.model,
    ...(configured.worker.reasoningEffort === undefined ? {} : { reasoningEffort: configured.worker.reasoningEffort }),
  }
  return { worker, reviewer: configured.reviewer === undefined ? { ...worker } : { ...configured.reviewer } }
}

/** Apply saved parent defaults through the native Session selector or the headless selector.
 * The Web selector owns its durable notice and pending-selection projection.
 * A saved assignment seeds new Web Sessions before they are exposed, then applies
 * when those settings change. Later explicit chat selections remain available.
 * Children are excluded.
 * @param ctx - plugin context owning listener lifetimes.
 * @param read - current configured assignments.
 */
export function installParentModelPolicy(ctx: Context, read: () => RoleModels): void {
  const states = new WeakMap<Agent, { key?: string; selection?: ModelSelectionRef; dispose?: () => unknown }>()
  ctx.on('agent/disposed', ({ agent }) => { states.get(agent)?.dispose?.(); states.delete(agent) })
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source !== 'startup' || agent.session.header.origin === 'subagent') return
    const selected = read().orchestrator
    if (selected === undefined) return
    const controller = ctx.get('sessionController')
    if (controller === undefined) return
    try {
      await controller.selectModel({ sessionId: agent.id, ...selected })
      const state = states.get(agent) ?? {}
      state.key = JSON.stringify(selected)
      states.set(agent, state)
    } catch (error) {
      ctx.logger.warn(`task-orchestrator: could not apply saved parent model to new Session: ${String(error)}`)
    }
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (agent === undefined || agent.session.header.origin === 'subagent') return next()
    const selected = read().orchestrator
    const key = JSON.stringify(selected)
    const state = states.get(agent) ?? {}
    states.set(agent, state)
    const controller = ctx.get('sessionController')
    if (controller !== undefined) {
      if (selected !== undefined && key !== state.key) {
        await controller.selectModel({ sessionId: agent.id, ...selected })
      }
      state.key = key
      return next()
    }
    if (state.selection === undefined) {
      const selection: ModelSelectionRef = { current: selected, assembled: selected }
      state.selection = selection
      state.dispose = ctx.effect(() => installModelSelection(agent.ctx, selection))
    }
    state.selection.current = selected
    const assembled = await next()
    state.selection.assembled = selected
    return selected === undefined ? assembled : {
      ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  }, { prepend: true })
}
