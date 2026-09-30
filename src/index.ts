/** TODO-first parent planning and bounded isolated worker execution. @module */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContentBlock, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_CONTEXT_TOKENS } from './adaptive.js'
import { ResourceManager, validateContextConcurrency } from './resource-manager.js'
import { readPlan, positiveInteger } from './validation.js'
import { runPlan, OrchestrationRunId, type RunnerPolicy } from './runner.js'
import { TOOL_PLAN_SCHEMA } from './schemas.js'
import type { PlannedTask } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-orchestrator': { kind: 'task-orchestrator' } & ContextFormed
  }
}

/** Plugin identifier used by the profile loader. */
export const name = 'task-orchestrator'
/** Existing services used without changing the agent loop. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/** Automatic orchestration mode. */
export type OrchestrationMode = 'off' | 'suggest' | 'hybrid' | 'auto'

/** Maximum active model streams allowed for requests up to one context size. */
export interface ContextConcurrency {
  maxContextTokens: number
  maxActiveGenerations: number
}

const DEFAULT_CONTEXT_CONCURRENCY: readonly ContextConcurrency[] = [
  { maxContextTokens: 8_192, maxActiveGenerations: 2 },
  { maxContextTokens: 16_384, maxActiveGenerations: 2 },
  { maxContextTokens: 24_576, maxActiveGenerations: 2 },
  { maxContextTokens: 32_768, maxActiveGenerations: 2 },
  { maxContextTokens: 49_152, maxActiveGenerations: 2 },
  { maxContextTokens: 65_536, maxActiveGenerations: 1 },
  { maxContextTokens: 81_920, maxActiveGenerations: 1 },
  { maxContextTokens: 98_304, maxActiveGenerations: 1 },
  { maxContextTokens: MAX_CONTEXT_TOKENS, maxActiveGenerations: 1 },
]

/** Deployment policy for automatic task orchestration. */
export interface ConfigValues {
  /** Disable automation, show a plan first, or execute complex requests automatically. */
  mode?: OrchestrationMode
  /** Minimum deterministic complexity score that starts planning. */
  minComplexityScore?: number
  /** Provider used for worker and reviewer children. */
  subagentProvider?: string
  /** Optional model override for all orchestration children. */
  subagentModel?: string
  /** Suggested independent initial task count in the planning instruction. */
  preferredWorkers?: number
  /** Hard worker count ceiling accepted from the parent-created graph. */
  maxWorkers?: number
  /** Logical task ceiling, including review. Retries use a separate start budget. */
  maxTotalAgents?: number
  /** Maximum concurrent worker children. */
  maxConcurrentAgents?: number
  /** Allow worker agents to modify the shared workspace. */
  allowWrites?: boolean
  /** Allow independent worker agents with declared write scopes to run together. */
  allowParallelWrites?: boolean
  /** Always run a final reviewer after worker execution. */
  requireReview?: boolean
  /** Maximum serialized plan or worker handoff size. */
  maxHandoffChars?: number
  /** Maximum characters added to the parent model's current request. */
  maxResultChars?: number
  /** Maximum model streams consumed at once by the local NInfer service. */
  maxActiveGenerations?: number
  /** Per-request concurrency ceilings selected by estimated input context. */
  concurrencyByContext?: ContextConcurrency[]
  /** Hard estimated input-token limit for one model request; zero disables this check. */
  hardContextTokens?: number
  /** Queue wait interval after which a request gains one priority level. */
  priorityAgingMs?: number
  /** Total estimated context budget for active requests; zero disables this budget check. */
  totalContextTokens?: number
  /** Maximum characters retained when a worker report is compacted for another task. */
  contextCompactionChars?: number
  /** Compatibility setting; must stay true because only the parent may plan. */
  parentOrchestratorOnly?: boolean
  /** Minimum independent initial tasks in a substantial-work plan. */
  minParallelTasks?: number
  /** Total child starts per run, including explicit retries and review. */
  maxChildStarts?: number
  /** Maximum explicit starts of one logical task. */
  maxAttemptsPerTask?: number
  /** Finite reminders when the parent finishes without the required plan. */
  maxPlanningReminders?: number
  /** Global tools a read-only child may use; absent tools are omitted. */
  readOnlyTools?: string[]
  /** LLM provider names sharing this scheduler. An empty list schedules all providers. */
  scheduledProviders?: string[]
  /** Output reserve for a request whose provider-neutral options omit maxTokens. */
  defaultOutputReserveTokens?: number
  /** Safety reserve for parent and other requests without a task-specific reserve. */
  requestSafetyReserveTokens?: number
}

/** Fields editable through the profile Settings page without unloading active runs. */
export type LiveSetting = 'mode' | 'maxWorkers' | 'maxConcurrentAgents' | 'requireReview'
  | 'maxActiveGenerations' | 'maxChildStarts' | 'maxAttemptsPerTask' | 'concurrencyByContext'
  | 'hardContextTokens' | 'totalContextTokens'

/** Cordis wraps editable fields in references that expose the latest saved values. */
export type Config = Omit<ConfigValues, LiveSetting> & {
  [K in LiveSetting]: Volatile<NonNullable<ConfigValues[K]>>
}

/** Schemastery configuration for the task orchestrator plugin. */
export const Config: z<ConfigValues, Config> = z.object({
  mode: z.union(['off', 'suggest', 'hybrid', 'auto']).default('hybrid').volatile(),
  minComplexityScore: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(55),
  subagentProvider: z.string().default('spawn'),
  subagentModel: z.string(),
  preferredWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  maxWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6).volatile(),
  maxTotalAgents: z.number().step(1).min(1).max(6).default(6),
  maxConcurrentAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2).volatile(),
  allowWrites: z.boolean().default(false),
  allowParallelWrites: z.boolean().default(false),
  requireReview: z.boolean().default(true).volatile(),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2).volatile(),
  concurrencyByContext: z.array(z.object({
    maxContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })).default([...DEFAULT_CONTEXT_CONCURRENCY]).volatile(),
  hardContextTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(65_536).volatile(),
  priorityAgingMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
  totalContextTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(98_304).volatile(),
  contextCompactionChars: z.number().step(1).min(128).max(Number.MAX_SAFE_INTEGER).default(4_096),
  parentOrchestratorOnly: z.boolean().default(true),
  minParallelTasks: z.number().step(1).min(1).max(6).default(2),
  maxChildStarts: z.number().step(1).min(1).max(48).default(12).volatile(),
  maxAttemptsPerTask: z.number().step(1).min(1).max(8).default(2).volatile(),
  maxPlanningReminders: z.number().step(1).min(0).max(4).default(2),
  readOnlyTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'list_skills', 'read_skill']),
  scheduledProviders: z.array(z.string()).default([]),
  defaultOutputReserveTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2_048),
  requestSafetyReserveTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1_024),
})


const COMPLEXITY_TERMS = [
  /frontend|front[- ]end|ui|ux|интерфейс|фронтенд|клиент/i,
  /backend|back[- ]end|api|database|db|сервер|бэкенд|база данных/i,
  /refactor|migration|архитектур|рефактор|миграц/i,
  /test|tests|e2e|ci|тест|провер/i,
  /document|docs|readme|документац/i,
  /review|audit|ревью|аудит/i,
  /all files|whole project|entire|весь проект|все файлы|полностью/i,
  /step by step|phases|dependencies|pipeline|этап|зависим|пайплайн/i,
]

/** Score a request using cheap deterministic signals before spending a child call. */
export function scoreComplexity(text: string): number {
  const normalized = text.trim()
  if (normalized.length === 0) return 0
  let score = 0
  if (normalized.length >= 180) score += 15
  if (normalized.length >= 500) score += 15
  if (/[\n\r]/.test(normalized)) score += 8
  if (/[,:;]|\d+[.)]/.test(normalized)) score += 7
  if (/(?:^|\s)(?:and|и|then|затем|also|также)(?:\s|$)/i.test(normalized)) score += 5
  for (const term of COMPLEXITY_TERMS) if (term.test(normalized)) score += 10
  return Math.min(score, 100)
}

/** Return the text blocks from a user message in their original order. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}


interface TurnPolicy { turn: number; required: boolean; saved: boolean; reminders: number }

function boundResult(value: JsonValue, maxChars: number): string {
  // Control information comes first; a large plan must not hide blockers or the identity needed to resume.
  const ordered = value !== null && typeof value === 'object' && !Array.isArray(value) ? {
    runId: value.runId, status: value.status, summary: value.summary, agentsStarted: value.agentsStarted,
    taskStates: Array.isArray(value.taskStates) ? value.taskStates.map(state => state !== null && typeof state === 'object' && !Array.isArray(state)
      ? { ...state, reason: typeof state.reason === 'string' ? state.reason.slice(0, 500) : state.reason } : state) : value.taskStates,
    review: value.review, workers: value.workers, plan: value.plan,
  } : value
  const serialized = JSON.stringify(ordered)
  const marker = '\n… [truncated; complete results remain in the saved TODO checkpoint]'
  return serialized.length <= maxChars ? serialized : serialized.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, maxChars)
}

/** Bind task execution to the current DSH services and live context settings. */
export function apply(ctx: Context, config: Config): void {
  const defaults = Config({})
  const get = <K extends keyof ConfigValues>(key: K): NonNullable<ConfigValues[K]> => {
    const value = config[key] ?? defaults[key]
    // Values come from the typed Cordis configuration resolver, which wraps only volatile fields.
    return (typeof value === 'object' && value !== null && 'get' in value ? value.get() : value) as NonNullable<ConfigValues[K]>
  }
  const resolvePolicy = (): RunnerPolicy => {
    const maxWorkers = Math.min(get('maxWorkers'), get('maxTotalAgents'))
    const maxConcurrentAgents = get('maxConcurrentAgents')
    const minParallelTasks = get('minParallelTasks')
    const concurrencyByContext = get('concurrencyByContext').map(tier => ({ ...tier }))
    validateContextConcurrency(concurrencyByContext, get('hardContextTokens'))
    for (const [key, value] of Object.entries({ maxWorkers, maxConcurrentAgents, minParallelTasks, preferredWorkers: get('preferredWorkers'), maxChildStarts: get('maxChildStarts'), maxAttemptsPerTask: get('maxAttemptsPerTask') })) positiveInteger(value, key)
    if (maxWorkers > 6 || maxConcurrentAgents > maxWorkers || minParallelTasks > maxConcurrentAgents || get('preferredWorkers') < minParallelTasks || get('preferredWorkers') > maxWorkers) throw new TypeError('Worker limits must allow the configured independent tasks and fit within six logical tasks')
    if (maxWorkers < minParallelTasks + (get('requireReview') ? 1 : 0)) throw new TypeError('maxWorkers must leave a slot for the required final reviewer')
    if (get('maxChildStarts') < maxWorkers) throw new TypeError('maxChildStarts must cover all logical tasks')
    if (!get('parentOrchestratorOnly')) throw new TypeError('parentOrchestratorOnly must be true; the parent owns planning')
    if (get('readOnlyTools').includes('run_code')) throw new TypeError('readOnlyTools must name end tools, not the PTC transport')
    return {
      maxWorkers, minParallelTasks, maxConcurrentAgents, maxChildStarts: get('maxChildStarts'), maxAttemptsPerTask: get('maxAttemptsPerTask'),
      allowWrites: get('allowWrites'), allowParallelWrites: get('allowParallelWrites'), requireReview: get('requireReview'),
      maxHandoffChars: get('maxHandoffChars'), contextCompactionChars: get('contextCompactionChars'),
      concurrencyByContext,
      ...(config.subagentModel === undefined ? {} : { subagentModel: config.subagentModel }),
    }
  }
  resolvePolicy()
  const budgetContext = new AsyncLocalStorage<PlannedTask>()
  const budgets = new Map<SessionId, PlannedTask>()
  const budgetFailures = new Map<SessionId, string>()
  ctx.on('agent/created', ({ agent }) => {
    const task = budgetContext.getStore()
    if (task !== undefined && agent.session.header.origin === 'subagent') budgets.set(agent.session.id, task)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { budgets.delete(agent.session.id); budgetFailures.delete(agent.session.id) })
  const resources = new ResourceManager({
    maxActiveGenerations: () => get('maxActiveGenerations'),
    hardContextTokens: () => get('hardContextTokens'), totalContextTokens: () => get('totalContextTokens'),
    concurrencyByContext: () => get('concurrencyByContext'), priorityAgingMs: get('priorityAgingMs'),
    defaultOutputReserveTokens: get('defaultOutputReserveTokens'), safetyReserveTokens: get('requestSafetyReserveTokens'),
    requestBudget: options => {
      const task = options.sessionId === undefined ? undefined : budgets.get(options.sessionId)
      return task === undefined ? undefined : { contextTokens: task.contextBudget!, safetyReserveTokens: task.safetyReserveTokens! }
    },
    onRejectedRequest: (options, reason) => {
      if (options.sessionId !== undefined && budgets.has(options.sessionId)) budgetFailures.set(options.sessionId, reason)
    },
  })
  ctx.effect(() => () => resources.close())
  ctx.on('llm/stream', (options, next) => get('scheduledProviders').length === 0 || get('scheduledProviders').includes(options.provider) ? resources.stream(ctx, options, next) : next())
  const turns = new WeakMap<Agent, TurnPolicy>()
  const active = new WeakSet<Agent>()
  const unload = new AbortController()
  const inflight = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    unload.abort()
    resources.close()
    await Promise.allSettled(inflight)
  })
  const planningReminder = (): string => {
    const { minParallelTasks, maxConcurrentAgents } = resolvePolicy()
    return `For substantive work, first prepare a concrete TODO plan with at least ${minParallelTasks} independent useful initial tasks, distinct assigned owner labels, dependencies and a final reviewer${get('requireReview') ? ' (required)' : ' when useful'}. Call task_orchestrate with this explicit plan. The plugin saves and displays TODO before starting children. At most ${maxConcurrentAgents} logical children run together, while the shared local scheduler admits at most ${get('maxActiveGenerations')} model streams INCLUDING the parent. Long contexts may require one stream. Other tasks remain queued. Do not delegate outside this plan. Short answers need no team. Use planOnly only when the human asked for planning or approval is still required. Existing user authorization is sufficient; do not ask again. Writes require configured permission or executeWrites=true when the human authorized implementation. If a child needs data, inspect its request, obtain the data and resume the saved runId with resumeContext. Do not claim blocked or failed work is complete.`
  }
  ctx.systemPrompt.section({ name: 'tool:task-orchestrate', order: 150, text: () => get('mode') === 'off' ? 'Automatic orchestration is disabled. The parent may use task_orchestrate when the human explicitly requests a task team. Existing runs may finish.' : planningReminder() })
  ctx.tools.register(defineTool({
    name: 'task_orchestrate',
    description: 'Save the parent-authored assigned TODO graph, then execute isolated workers through a bounded queue. Explicit plan is mandatory. Return partial results and precise blockers to the parent. Resume by runId with newly supplied task data. Never generates a plan from keywords.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concrete user objective.' },
      plan: { ...TOOL_PLAN_SCHEMA, required: true },
      planOnly: { type: 'boolean', description: 'Save and display TODO without starting children.' },
      executeWrites: { type: 'boolean', description: 'True only when the human has already authorized implementation.' },
      maxWorkers: { type: 'number', description: 'Optional smaller logical task ceiling, including review.' },
      runId: { type: 'string', description: 'Saved run to continue. Keep task assignments; unfinished task packets and budgets may be corrected. Completed task inputs remain unchanged.' },
      resumeContext: { type: 'json', description: 'Object mapping waiting task IDs to newly obtained data or corrected instructions. No automatic retries without this data.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        runId: { type: 'string', required: true }, agentsStarted: { type: 'integer', required: true }, result: { type: 'json', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: boundResult(value.result, get('maxResultChars')) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined || parent.session.header.origin === 'subagent') throw new Error('Only the parent orchestrator may execute a task plan')
      if (active.has(parent)) throw new Error('This parent already has an active task plan')
      const objective = args.objective.trim()
      if (objective.length === 0 || objective.length > get('maxHandoffChars')) throw new TypeError('objective must fit maxHandoffChars and be non-empty')
      const plan = readPlan(args.plan, get('maxHandoffChars'))
      const policy = resolvePolicy()
      const maxWorkers = policy.maxWorkers
      const requestedCap = args.maxWorkers === undefined ? maxWorkers : positiveInteger(args.maxWorkers, 'maxWorkers')
      if (requestedCap > maxWorkers) throw new TypeError('maxWorkers exceeds the deployment ceiling')
      const provider = ctx.subagents.getProvider(get('subagentProvider'))
      if (provider === undefined || provider.inheritsParentContext || !provider.capabilities.outputSchema || !provider.capabilities.agentOptions || !provider.capabilities.toolFilter) throw new Error('Provider must support fresh contexts, structured reports, tool restrictions and output-token limits')
      const allowed = get('readOnlyTools').filter(name => ctx.tools.get(name) !== undefined)
      const deniedDelegation = ['task_orchestrate', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent'].filter(name => ctx.tools.get(name) !== undefined)
      let resumeContext: Record<string, string> | undefined
      if (args.resumeContext !== undefined) {
        if (typeof args.resumeContext !== 'object' || args.resumeContext === null || Array.isArray(args.resumeContext)) throw new TypeError('resumeContext must be an object')
        resumeContext = {}
        for (const [id, text] of Object.entries(args.resumeContext)) {
          if (typeof text !== 'string') throw new TypeError('resumeContext values must be text')
          resumeContext[id] = text
        }
      }
      active.add(parent)
      try {
        const pending = runPlan({
          parent, signal: AbortSignal.any([exec.signal, unload.signal]), readOnlyFilter: { allow: allowed },
          ...(deniedDelegation.length === 0 ? {} : { writeFilter: { deny: deniedDelegation } }),
          childIsLive: id => ctx.agents.get(id) !== undefined,
          failureDetail: id => budgetFailures.get(id),
          start: (request, task) => budgetContext.run(task, () => ctx.subagents.start(get('subagentProvider'), request)),
        }, { ...policy, maxWorkers: requestedCap }, {
          objective, plan, planOnly: args.planOnly ?? false, executeWrites: args.executeWrites ?? false,
          ...(args.runId === undefined ? {} : { runId: OrchestrationRunId(args.runId) }), ...(resumeContext === undefined ? {} : { resumeContext }),
        })
        inflight.add(pending)
        let value: Awaited<typeof pending>
        try { value = await pending } finally { inflight.delete(pending) }
        const state = turns.get(parent)
        if (state !== undefined) state.saved = true
        // JSON serialization strips no runtime capabilities: this result contains only the recorded plan, states and reports.
        const result: JsonValue = JSON.parse(JSON.stringify(value))
        return { runId: value.runId, agentsStarted: value.agentsStarted, result }
      } finally { active.delete(parent) }
    },
    presentCall: args => ({ card: 'generic', title: 'task orchestrator', rawInput: args.objective }),
    presentResult: () => ({ card: 'generic' }),
  }))
  ctx.tools.guard(exec => {
    const parent = exec.agent
    if (parent === undefined || parent.session.header.origin === 'subagent') return undefined
    const state = turns.get(parent)
    if (!state?.required) return undefined
    if (['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent'].includes(exec.name)) return 'Use task_orchestrate with the assigned TODO plan; direct delegation bypasses the task queue.'
    if (!state.saved && exec.name !== 'task_orchestrate' && exec.name !== 'run_code' && !get('readOnlyTools').includes(exec.name) && !['ask_user', 'request_user_input', 'todo_write', 'plan'].includes(exec.name)) return 'Save an assigned plan through task_orchestrate before implementation.'
    return undefined
  })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || agent.session.header.origin === 'subagent') return decision
    if (step === 1) {
      const mode = get('mode')
      if (mode === 'off') { turns.delete(agent); return decision }
      const reminder = planningReminder()
      const objective = messages.map(messageText).join('\n').trim()
      const required = scoreComplexity(objective) >= get('minComplexityScore')
        || /(?:реализуй|исправь|доработай|разработай|внедри|implement|fix|refactor|build).*(?:проект|плагин|код|project|plugin|code|feature)/is.test(objective)
      turns.set(agent, { turn, required, saved: false, reminders: 0 })
      if (!required) return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: reminder + (mode === 'suggest' ? ' Start with planOnly=true unless the human already authorized execution.' : '') }], source: { kind: name, form: 'notice', summary: 'Create and assign TODO before work' } })] }
    }
    return decision
  })
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = turns.get(agent)
    if (signal.aborted || state?.turn !== turn || !state.required || state.saved) return
    if (state.reminders >= get('maxPlanningReminders')) throw new Error('Required TODO plan was not saved; orchestration is incomplete')
    state.reminders += 1
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'The assigned TODO plan has not been saved. Call task_orchestrate now with your explicit plan, or report the concrete blocker that prevents planning. ' + planningReminder() }], source: { kind: name, form: 'notice', summary: 'Required plan is missing' } }))
  })
}

export type { OrchestrationResult, PlannedTask, ReviewReport, TaskPlan, TaskRisk, WorkerReport } from './types.js'
