/** Execute the parent's saved graph through isolated, disposable children. @module */
import { randomUUID } from 'node:crypto'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { OrchestrationResult, PlannedTask, TaskPlan, TaskState, WorkerReport } from './types.js'
import { readPlan, readWorker, readReview, record, positiveInteger, compactReport } from './validation.js'
import { WORKER_SCHEMA, REVIEW_SCHEMA } from './schemas.js'
import type { ContextConcurrencyLimit } from './resource-manager.js'

/** A run's complete checkpoint, owned by the parent session. */
export interface Checkpoint {
  version: 1
  runId: OrchestrationRunId
  objective: string
  result: OrchestrationResult & { plan: TaskPlan; taskStates: TaskState[] }
}

/** Opaque identity of a saved orchestration run. */
export type OrchestrationRunId = Branded<'OrchestrationRunId'>

/** Decode a generated run identity from model or checkpoint JSON. */
export function OrchestrationRunId(value: string): OrchestrationRunId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new TypeError('Invalid orchestration runId')
  return value as OrchestrationRunId
}

/** Limits resolved once by the deployment configuration. */
export interface RunnerPolicy {
  maxWorkers: number
  minParallelTasks: number
  maxConcurrentAgents: number
  maxChildStarts: number
  maxAttemptsPerTask: number
  allowWrites: boolean
  allowParallelWrites: boolean
  requireReview: boolean
  maxHandoffChars: number
  contextCompactionChars: number
  concurrencyByContext: readonly ContextConcurrencyLimit[]
  subagentModel?: string
  /** Effective worker route and explicitly owned reasoning captured for this invocation. */
  workerModel?: ModelSelection
  /** Effective reviewer route; absence inherits the worker selection. */
  reviewerModel?: ModelSelection
}

/** One explicit invocation, with optional missing data for a saved run. */
export interface RunRequest {
  objective: string
  plan: TaskPlan
  planOnly: boolean
  executeWrites: boolean
  runId?: OrchestrationRunId
  resumeContext?: Record<string, string>
}

/** Host services supplied to the scheduler; test providers control settlement. */
export interface RunnerHost {
  parent: Agent
  signal: AbortSignal
  start: (request: SubagentStartRequest, task: PlannedTask) => Promise<SubagentRun>
  readOnlyFilter: ToolRestriction
  writeFilter?: ToolRestriction
  childIsLive: (id: SessionId) => boolean
  failureDetail?: (id: SessionId) => string | undefined
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Derive native TODO from the authoritative task graph and its current states. */
export function projectTodo(plan: TaskPlan, states: readonly TaskState[]): TodoItem[] {
  return plan.tasks.map(task => {
    const state = states.find(item => item.taskId === task.id)!
    return {
      content: `[${task.id}] ${task.title} — ${task.owner} (${state.reason.length > 300 ? state.reason.slice(0, 299) + '…' : state.reason})`,
      status: state.state === 'DONE' ? 'completed' : state.state === 'ACTIVE' ? 'in_progress' : 'pending',
    }
  })
}

/** Validate deployment-dependent obligations before persisting or starting work. */
export function validateScheduling(plan: TaskPlan, policy: RunnerPolicy): void {
  if (plan.tasks.length > policy.maxWorkers) throw new TypeError(`Plan exceeds the ${policy.maxWorkers}-task ceiling, including review`)
  const reviewers = plan.tasks.filter(task => task.role === 'reviewer')
  if (policy.requireReview && reviewers.length !== 1) throw new TypeError('Plan must assign exactly one final reviewer')
  if (reviewers.length > 1) throw new TypeError('Plan may contain only one final reviewer')
  const workers = plan.tasks.filter(task => task.role !== 'reviewer')
  for (const reviewer of reviewers) {
    if (!reviewer.readOnly || !workers.every(task => reviewer.dependsOn.includes(task.id))) throw new TypeError('Final reviewer must be read-only and depend on every worker')
    if (workers.some(task => task.dependsOn.includes(reviewer.id))) throw new TypeError('A worker cannot depend on the final reviewer')
  }
  const initial = workers.filter(task => task.dependsOn.length === 0)
  if (initial.length < policy.minParallelTasks) throw new TypeError(`Assign at least ${policy.minParallelTasks} independent initial tasks with distinct useful outputs`)
  if (new Set(initial.map(task => task.prompt.trim().toLowerCase())).size !== initial.length) throw new TypeError('Independent initial tasks must have distinct goals, not duplicate prompts')
}

function readCheckpoint(value: unknown, policy: RunnerPolicy): Checkpoint {
  const raw = record(value)
  if (raw.version !== 1 || typeof raw.runId !== 'string' || typeof raw.objective !== 'string') throw new TypeError('Unsupported orchestration checkpoint')
  const result = record(raw.result)
  const plan = readPlan(result.plan, policy.maxHandoffChars)
  validateScheduling(plan, policy)
  if (!Array.isArray(result.workers) || !Array.isArray(result.taskStates)) throw new TypeError('Malformed checkpoint results')
  const taskStates: TaskState[] = result.taskStates.map((value: unknown) => {
    const item = record(value)
    const task = plan.tasks.find(task => task.id === item.taskId)
    const state = ['CREATED', 'QUEUED', 'ACTIVE', 'WAITING', 'DONE', 'FAILED', 'CANCELLED', 'PARKED'].find(state => state === item.state) as TaskState['state'] | undefined
    if (task === undefined || state === undefined || typeof item.reason !== 'string' || typeof item.attempts !== 'number' || !Number.isSafeInteger(item.attempts) || item.attempts < 0) throw new TypeError('Malformed checkpoint task state')
    return { taskId: task.id, owner: task.owner, state, attempts: item.attempts, reason: item.reason, ...(typeof item.childId === 'string' ? { childId: item.childId as SessionId } : {}) }
  })
  if (taskStates.length !== plan.tasks.length || new Set(taskStates.map(state => state.taskId)).size !== plan.tasks.length) throw new TypeError('Checkpoint task states do not match the plan')
  const workers = result.workers.map((value: unknown) => {
    const raw = record(value)
    const task = plan.tasks.find(task => task.id === raw.taskId && task.role !== 'reviewer')
    if (task === undefined) throw new TypeError('Unknown checkpoint worker')
    return readWorker(value, task.id, policy.maxHandoffChars)
  })
  if (new Set(workers.map(worker => worker.taskId)).size !== workers.length) throw new TypeError('Duplicate checkpoint report')
  const review = result.review === null ? null : readReview(result.review, policy.maxHandoffChars)
  const status = ['completed', 'plan-only', 'blocked', 'failed'].find(status => status === result.status) as OrchestrationResult['status'] | undefined
  if (status === undefined || typeof result.summary !== 'string') throw new TypeError('Malformed checkpoint status')
  for (const state of taskStates.filter(state => state.state === 'DONE')) {
    const task = plan.tasks.find(task => task.id === state.taskId)!
    if (task.role === 'reviewer' ? review?.status !== 'approved' : !workers.some(report => report.taskId === task.id && report.status === 'completed')) throw new TypeError('Completed checkpoint task lacks successful evidence')
  }
  return { version: 1, runId: OrchestrationRunId(raw.runId), objective: raw.objective, result: {
    status, summary: result.summary, plan, workers, review, taskStates,
    agentsStarted: result.agentsStarted === 0 ? 0 : positiveInteger(result.agentsStarted, 'agentsStarted'),
  } }
}

function scopesOverlap(left: string, right: string): boolean {
  const normalize = (scope: string): string => scope.replaceAll('\\', '/').toLowerCase().split(/[?*]/)[0]!.replace(/\/$/, '')
  const a = normalize(left), b = normalize(right)
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '' || b === ''
}

/** Save TODO before child creation, then refill individual worker slots on settlement. */
export async function runPlan(host: RunnerHost, policy: RunnerPolicy, request: RunRequest): Promise<OrchestrationResult & { runId: OrchestrationRunId }> {
  validateScheduling(request.plan, policy)
  const events = host.parent.session.snapshotEvents()
  const previousValue = request.runId === undefined ? undefined : [...events].reverse().flatMap(event => {
    if (event.type !== 'todo/write') return []
    const data = record(event.data)
    if (data.orchestration === undefined) return []
    return record(data.orchestration).runId === request.runId ? [data.orchestration] : []
  })[0]
  const previous = previousValue === undefined ? undefined : readCheckpoint(previousValue, policy)
  if (request.runId !== undefined && previous === undefined) throw new TypeError('Saved runId was not found in this parent session')
  const changedTasks = new Set<string>()
  if (previous !== undefined) {
    if (previous.objective !== request.objective || previous.result.plan.tasks.length !== request.plan.tasks.length) throw new TypeError('Resume must keep the objective and assigned task identities')
    const assignment = (task: PlannedTask): string => JSON.stringify({ id: task.id, title: task.title, owner: task.owner, role: task.role, prompt: task.prompt, dependsOn: task.dependsOn, readOnly: task.readOnly, writeScopes: task.writeScopes })
    for (const task of request.plan.tasks) {
      const original = previous.result.plan.tasks.find(item => item.id === task.id)
      if (original === undefined || assignment(original) !== assignment(task)) throw new TypeError('Resume cannot change task assignments, goals, dependencies or write permissions')
      if (JSON.stringify(original) === JSON.stringify(task)) continue
      if (previous.result.taskStates.find(state => state.taskId === task.id)!.state === 'DONE') throw new TypeError('Completed task inputs cannot change when reusing its evidence')
      changedTasks.add(task.id)
    }
    if (previous.result.plan.requiresConfirmation && !request.plan.requiresConfirmation) throw new TypeError('Resume cannot remove the plan approval requirement')
  }
  const extra = request.resumeContext ?? {}
  for (const [id, context] of Object.entries(extra)) {
    if (!request.plan.tasks.some(task => task.id === id) || typeof context !== 'string' || context.trim().length === 0 || context.length > policy.maxHandoffChars) throw new TypeError(`Invalid resumeContext for ${id}`)
  }
  const checkpoint: Checkpoint = previous === undefined ? {
    version: 1, runId: OrchestrationRunId(randomUUID()), objective: request.objective,
    result: { status: 'blocked', summary: 'Plan saved; tasks are waiting to start.', plan: request.plan,
      workers: [], review: null, agentsStarted: 0,
      taskStates: request.plan.tasks.map(task => ({ taskId: task.id, owner: task.owner, state: 'QUEUED', attempts: 0, reason: task.dependsOn.length === 0 ? 'queued' : `waiting for: ${task.dependsOn.join(', ')}` })),
    },
  } : structuredClone(previous)
  const result = checkpoint.result
  result.plan = request.plan
  const states = new Map(result.taskStates.map(state => [state.taskId, state]))
  for (const state of result.taskStates) {
    if (state.state !== 'DONE' && state.childId !== undefined && host.childIsLive(state.childId)) throw new Error(`Saved child ${state.childId} is still live; a duplicate will not be started`)
    if (state.state === 'ACTIVE') {
      state.state = 'WAITING'; state.reason = 'previous run interrupted; instructions are needed to resume'
    }
    if (state.state === 'WAITING' && state.attempts === 0) state.state = 'QUEUED'
    if ((extra[state.taskId] !== undefined || changedTasks.has(state.taskId)) && state.state !== 'DONE') {
      state.state = 'QUEUED'; state.reason = 'new information received'
    }
  }
  const save = (): void => {
    // Native TODO and plugin checkpoint share one existing event. Older TODO readers select `todos` and retain the extra JSON data.
    const data = { todos: projectTodo(result.plan, result.taskStates), orchestration: structuredClone(checkpoint) }
    host.parent.session.append('todo/write', data)
  }
  save()
  if (request.planOnly || request.plan.requiresConfirmation && !request.executeWrites || request.plan.tasks.some(task => !task.readOnly) && !(policy.allowWrites || request.executeWrites)) {
    result.status = 'plan-only'; result.summary = 'Plan and assignments saved in TODO; execution awaits authorization required by this plan.'; save()
    return { runId: checkpoint.runId, ...result }
  }
  if (result.status === 'completed') return { runId: checkpoint.runId, ...result }
  const controller = new AbortController()
  const signal = AbortSignal.any([host.signal, controller.signal])
  const running = new Map<string, Promise<void>>()
  const limitFor = (task: PlannedTask): number => policy.concurrencyByContext.find(tier => task.contextBudget! <= tier.maxContextTokens)?.maxActiveGenerations ?? 1
  const canStart = (task: PlannedTask): boolean => {
    const active = result.plan.tasks.filter(task => running.has(task.id))
    if (active.length >= Math.min(policy.maxConcurrentAgents, limitFor(task), ...active.map(limitFor))) return false
    if (!task.readOnly && active.some(sibling => !sibling.readOnly && (!policy.allowParallelWrites || sibling.writeScopes.some(scope => task.writeScopes.some(other => scopesOverlap(scope, other)))))) return false
    return true
  }
  const promptFor = (task: PlannedTask): string => {
    const reports = result.workers.filter(report => task.dependsOn.includes(report.taskId)).map(report => compactReport(report, policy.contextCompactionChars))
    const prompt = [
      `Objective: ${request.objective}`, `Task: ${task.id}. Assigned worker: ${task.owner}. Role: ${task.role}.`,
      task.prompt, `Task packet: ${JSON.stringify(task.taskPackage ?? { taskId: task.id, goal: task.prompt })}`,
      `Read-only: ${task.readOnly}. Declared write scopes: ${JSON.stringify(task.writeScopes)}.`,
      `Context ceiling including output and safety: ${task.contextBudget}. Output limit per request: ${task.outputReserveTokens}.`,
      `The worker report taskId must be exactly ${JSON.stringify(task.id)}. Return structured evidence. Do not delegate or start an orchestration.`,
      'If data or budget is missing, return needs_more_context with a precise NEED_FILE/NEED_HISTORY/NEED_BUDGET request. Do not invent missing information.',
      reports.length === 0 ? '' : `Dependency reports (partial text may be marked compacted):\n${reports.join('\n')}`,
      extra[task.id] === undefined ? '' : `Additional information supplied by the parent:\n${extra[task.id]}`,
    ].filter(Boolean).join('\n\n')
    if (prompt.length > policy.maxHandoffChars) throw new Error(`${task.id}: combined handoff exceeds maxHandoffChars; shorten context and dependency summaries`)
    return prompt
  }
  const perform = async (task: PlannedTask): Promise<void> => {
    const state = states.get(task.id)!
    let run: SubagentRun | undefined
    try {
      if (state.attempts >= policy.maxAttemptsPerTask || result.agentsStarted >= policy.maxChildStarts) throw new Error('Child start/attempt budget exhausted; parent must revise the work')
      const prompt = promptFor(task)
      state.state = 'ACTIVE'; state.reason = 'running'; state.attempts += 1; result.agentsStarted += 1; save()
      const schema: ObjectJsonSchema = task.role === 'reviewer' ? REVIEW_SCHEMA : { ...WORKER_SCHEMA, properties: { ...WORKER_SCHEMA.properties, taskId: { type: 'string', const: task.id } } }
      const model = task.role === 'reviewer' ? policy.reviewerModel ?? policy.workerModel : policy.workerModel
      run = await host.start({
        parent: host.parent, signal, label: `${task.owner}: ${task.title}`,
        prompt: [{ type: 'text', text: prompt }], outputSchema: schema,
        agentOptions: { maxTokens: task.outputReserveTokens!, ...(model === undefined
          ? policy.subagentModel === undefined ? {} : { model: policy.subagentModel }
          : { ...model, reasoningEffort: model.reasoningEffort }) },
        toolFilter: task.readOnly ? host.readOnlyFilter : host.writeFilter,
      }, task)
      state.childId = run.id; save()
      const settled = await run.result
      if (settled.stopReason !== 'completed') {
        const detail = host.failureDetail?.(run.id) ?? settled.diagnostic
        throw new Error(`Child stopped: ${settled.stopReason}${detail === undefined ? '' : ` — ${detail}`}`)
      }
      if (task.role === 'reviewer') {
        result.review = readReview(settled.structured, policy.maxHandoffChars)
        state.state = result.review.status === 'approved' ? 'DONE' : result.review.status === 'failed' ? 'FAILED' : 'WAITING'
        state.reason = result.review.summary
      } else {
        const report = readWorker(settled.structured, task.id, policy.maxHandoffChars)
        if (task.readOnly && report.changedFiles.length > 0) throw new Error('Read-only child reported file changes')
        result.workers = [...result.workers.filter(worker => worker.taskId !== task.id), report]
        state.state = report.status === 'completed' ? 'DONE' : report.status === 'failed' ? 'FAILED' : 'WAITING'
        state.reason = report.status === 'completed' ? 'completed' : [...(report.needs?.map(need => `${need.kind}: ${need.reason}`) ?? []), report.summary, ...report.blockers].join('; ')
      }
    } catch (error) {
      state.state = signal.aborted ? 'CANCELLED' : 'FAILED'; state.reason = errorText(error)
      if (task.role !== 'reviewer') result.workers = [...result.workers.filter(worker => worker.taskId !== task.id), {
        taskId: task.id, status: 'failed', summary: state.reason, evidence: [], changedFiles: [], tests: [], blockers: [state.reason], nextSteps: ['Parent must inspect the failure and supply a correction before resuming.'],
      }]
    } finally {
      if (run !== undefined) {
        try { await run.dispose() } catch (error) { state.state = 'FAILED'; state.reason = `Child cleanup failed: ${errorText(error)}` }
      }
      save()
    }
  }
  try {
    while (!signal.aborted) {
      for (const task of result.plan.tasks) {
        const state = states.get(task.id)!
        if (state.state !== 'QUEUED' || !task.dependsOn.every(id => states.get(id)!.state === 'DONE') || !canStart(task)) continue
        const pending = perform(task).finally(() => { running.delete(task.id) })
        running.set(task.id, pending)
      }
      if (running.size === 0) break
      await Promise.race(running.values())
    }
  } finally {
    controller.abort()
    await Promise.allSettled(running.values())
  }
  for (const task of result.plan.tasks) {
    const state = states.get(task.id)!
    if (state.state !== 'QUEUED') continue
    state.state = host.signal.aborted ? 'CANCELLED' : 'WAITING'
    state.reason = host.signal.aborted ? 'cancelled by the user' : `unfinished dependencies: ${task.dependsOn.filter(id => states.get(id)!.state !== 'DONE').join(', ')}`
  }
  result.status = result.taskStates.every(state => state.state === 'DONE') && (!policy.requireReview || result.review?.status === 'approved')
    ? 'completed' : result.taskStates.some(state => state.state === 'FAILED' || state.state === 'CANCELLED') ? 'failed' : 'blocked'
  result.summary = result.status === 'completed' ? 'All tasks completed; required review approved.' : 'Partial results and stopping reasons saved. The parent must handle unfinished tasks.'
  save()
  return { runId: checkpoint.runId, ...result }
}
