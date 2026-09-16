/**
 * Pure planning helpers for the adaptive worker scheduler.
 *
 * The helpers deliberately use estimates only for admission. NInfer remains
 * the authority for token counts, memory placement, and whether a continuation
 * was restored from Device or Host memory.
 */

import type { PlannedTask, TaskPlan, TaskRole } from './types.js'

/** Context budgets offered to a worker. The value is a logical ceiling. */
export const CONTEXT_TIERS = [8_192, 16_384, 24_576, 32_768, 49_152, 65_536, 81_920, 98_304] as const

/** A supported worker context budget. */
export type ContextTier = (typeof CONTEXT_TIERS)[number]

/** Durable lifecycle values for one logical task. */
export type TaskLifecycle = 'CREATED' | 'QUEUED' | 'ACTIVE' | 'WAITING' | 'DONE' | 'FAILED' | 'CANCELLED' | 'PARKED'

/** A structured request from a worker that cannot finish with its current handoff. */
export interface WorkerNeed {
  /** Machine-readable request kind. */
  readonly kind: 'NEED_FILE' | 'NEED_HISTORY' | 'NEED_MORE_CONTEXT' | 'NEED_DEPENDENCY' | 'NEED_BUDGET' | 'NEED_TOOL_RESULT' | 'NEED_MORE_TOOL' | 'NEED_REVIEW'
  /** Human-readable reason that can be shown to the orchestrator. */
  readonly reason: string
  /** Minimum context budget requested, when the worker needs more history. */
  readonly requestedContextTokens?: ContextTier
}

/** The isolated information packet sent to one worker. */
export interface TaskPackage {
  readonly taskId: string
  readonly goal: string
  readonly relevantContext: string[]
  readonly constraints: string[]
  readonly knownFacts: string[]
  readonly files: string[]
  readonly dependencies: string[]
  readonly expectedOutput: string
  readonly doNot: string[]
}

/** Scheduler metadata attached to a task package. */
export interface TaskBudget {
  readonly contextTokens: ContextTier
  readonly outputReserveTokens: number
  readonly safetyReserveTokens: number
}

/** One ready task selected for a generation batch. */
export interface ScheduledTask {
  readonly task: PlannedTask
  readonly budget: TaskBudget
  readonly package: TaskPackage
}

/** Safety limits used by the deterministic batch packer. */
export interface PackingPolicy {
  readonly maxWorkers: number
  readonly maxActiveGenerations: number
  readonly totalContextTokens: number
  readonly safetyReserveTokens: number
}

/** Choose the smallest supported tier that can hold a request. */
export function selectContextTier(requestedTokens: number, hardLimit: number = 98_304): ContextTier | undefined {
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) throw new TypeError('requestedTokens must be a positive safe integer')
  if (!Number.isSafeInteger(hardLimit) || hardLimit < 1) throw new TypeError('hardLimit must be a positive safe integer')
  return CONTEXT_TIERS.find(tier => tier >= requestedTokens && tier <= hardLimit)
}

/** Return a conservative token budget for one worker request. */
export function estimateTaskBudget(contextTokens: ContextTier, outputReserveTokens = 2_048, safetyReserveTokens = 1_024): TaskBudget {
  for (const [name, value] of [['outputReserveTokens', outputReserveTokens], ['safetyReserveTokens', safetyReserveTokens]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return { contextTokens, outputReserveTokens, safetyReserveTokens }
}

/**
 * Select a first batch with greedy bin packing.
 *
 * Tasks are sorted by declared context need, largest first. This keeps a
 * large task from being stranded behind several small tasks while preserving
 * the configured FIFO order for equal budgets.
 */
export function packReadyTasks(tasks: readonly ScheduledTask[], policy: PackingPolicy): { selected: ScheduledTask[]; deferred: ScheduledTask[] } {
  if (!Number.isSafeInteger(policy.maxWorkers) || policy.maxWorkers < 1) throw new TypeError('maxWorkers must be a positive safe integer')
  if (!Number.isSafeInteger(policy.maxActiveGenerations) || policy.maxActiveGenerations < 1) throw new TypeError('maxActiveGenerations must be a positive safe integer')
  if (!Number.isSafeInteger(policy.totalContextTokens) || policy.totalContextTokens < 1) throw new TypeError('totalContextTokens must be a positive safe integer')
  if (!Number.isSafeInteger(policy.safetyReserveTokens) || policy.safetyReserveTokens < 0) throw new TypeError('safetyReserveTokens must be a non-negative safe integer')
  const selected: ScheduledTask[] = []
  const deferred: ScheduledTask[] = []
  let used = 0
  const sorted = tasks.map((task, index) => ({ task, index })).sort((left, right) => {
    const byBudget = right.task.budget.contextTokens - left.task.budget.contextTokens
    return byBudget === 0 ? left.index - right.index : byBudget
  })
  const slots = Math.min(policy.maxWorkers, policy.maxActiveGenerations)
  for (const entry of sorted) {
    const cost = entry.task.budget.contextTokens + entry.task.budget.outputReserveTokens + entry.task.budget.safetyReserveTokens + policy.safetyReserveTokens
    if (selected.length < slots && used + cost <= policy.totalContextTokens) {
      selected.push(entry.task)
      used += cost
    } else {
      deferred.push(entry.task)
    }
  }
  return { selected, deferred }
}

function roleForObjective(objective: string): TaskRole[] {
  const roles: TaskRole[] = ['researcher']
  const add = (role: TaskRole, pattern: RegExp): void => {
    if (pattern.test(objective) && !roles.includes(role)) roles.push(role)
  }
  add('architect', /architect|architecture|design|архитект|дизайн/i)
  add('backend', /backend|api|database|server|бэкенд|сервер|база/i)
  add('frontend', /frontend|ui|ux|interface|frontend|интерфейс/i)
  add('tester', /test|tests|e2e|ci|тест|провер/i)
  add('documentation', /document|docs|readme|документац/i)
  return roles
}

function contextForRole(role: TaskRole): ContextTier {
  switch (role) {
    case 'researcher': return 24_576
    case 'architect': return 49_152
    case 'backend': return 32_768
    case 'frontend': return 32_768
    case 'tester': return 24_576
    case 'documentation': return 16_384
    case 'reviewer': return 32_768
    /* v8 ignore start -- TaskRole is extended by declaration only with a code change. */
    default: return 24_576
    /* v8 ignore stop */
  }
}

/** Build a small deterministic graph when the parent orchestrator supplies no model plan. */
export function buildAdaptivePlan(objective: string, preferredWorkers: number, maxWorkers: number, includeReviewer: boolean): TaskPlan {
  if (objective.trim().length === 0) throw new TypeError('objective must be non-empty')
  if (!Number.isSafeInteger(preferredWorkers) || preferredWorkers < 1) throw new TypeError('preferredWorkers must be a positive safe integer')
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || preferredWorkers > maxWorkers) throw new TypeError('maxWorkers must be a positive safe integer at least preferredWorkers')
  const requestedRoles = roleForObjective(objective)
  // Keep the full candidate graph so the execution script can start with the
  // preferred count and admit additional roles after earlier results settle.
  // The preference controls admission, not graph construction.
  const roles = requestedRoles.slice(0, maxWorkers)
  const tasks: PlannedTask[] = roles.map((role, index) => ({
    id: `worker-${index + 1}`,
    title: `${role} pass`,
    role,
    prompt: `Work only on the ${role} part of the objective and return evidence that another agent can check.`,
    dependsOn: index === 0 ? [] : role === 'architect' ? ['worker-1'] : [],
    readOnly: true,
    writeScopes: [],
    contextBudget: contextForRole(role),
    outputReserveTokens: 2_048,
    safetyReserveTokens: 1_024,
    taskPackage: {
      taskId: `worker-${index + 1}`,
      goal: objective.trim(),
      relevantContext: [],
      constraints: ['Keep the task isolated from other workers.', 'Use only the declared files and tools.'],
      knownFacts: [],
      files: [],
      dependencies: index === 0 ? [] : role === 'architect' ? ['worker-1'] : [],
      expectedOutput: 'A structured report with findings, evidence, risks, and next steps.',
      doNot: ['Do not start another orchestration.', 'Do not claim unverified work as complete.'],
    },
  }))
  if (includeReviewer && tasks.length < maxWorkers) {
    const id = `worker-${tasks.length + 1}`
    tasks.push({
      id,
      title: 'review pass',
      role: 'reviewer',
      prompt: 'Review the collected worker evidence and identify concrete gaps or contradictions.',
      dependsOn: tasks.map(task => task.id),
      readOnly: true,
      writeScopes: [],
      contextBudget: contextForRole('reviewer'),
      outputReserveTokens: 2_048,
      safetyReserveTokens: 1_024,
      taskPackage: {
        taskId: id,
        goal: objective.trim(),
        relevantContext: [],
        constraints: ['Review only completed reports and current workspace evidence.'],
        knownFacts: [],
        files: [],
        dependencies: tasks.map(task => task.id),
        expectedOutput: 'A structured review report with findings and a recommendation.',
        doNot: ['Do not edit files.', 'Do not certify evidence that was not checked.'],
      },
    })
  }
  const requiresConfirmation = /write|edit|change|delete|migrat|implement|реализ|измен|удал|запис/i.test(objective)
  return { summary: 'Adaptive parent-orchestrator plan.', risk: requiresConfirmation ? 'high' : 'medium', requiresConfirmation, tasks }
}
