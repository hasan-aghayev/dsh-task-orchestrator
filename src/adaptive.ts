/**
 * Pure planning helpers for the adaptive worker scheduler.
 *
 * The helpers deliberately use estimates only for admission. NInfer remains
 * the authority for token counts, memory placement, and whether a continuation
 * was restored from Device or Host memory.
 */

import type { PlannedTask } from './types.js'

/** Context budgets offered to a worker. Larger budgets advance in 1,024-token steps. */
const STANDARD_CONTEXT_TIERS = [8_192, 16_384, 24_576, 32_768, 49_152, 65_536, 81_920, 98_304] as const

/** Highest context budget accepted by the worker planner. */
export const MAX_CONTEXT_TOKENS = 150_000

/** Context budgets offered to a worker. The value is a logical ceiling. */
export const CONTEXT_TIERS: readonly number[] = [
  ...STANDARD_CONTEXT_TIERS,
  ...Array.from(
    { length: Math.floor((MAX_CONTEXT_TOKENS - 98_304) / 1_024) },
    (_, index) => 98_304 + (index + 1) * 1_024,
  ),
  MAX_CONTEXT_TOKENS,
]

/** Whole-token worker budget, checked against {@link CONTEXT_TIERS} at runtime. */
export type ContextTier = number

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
  /** Maximum combined estimate; zero leaves the combined budget unlimited. */
  readonly totalContextTokens: number
  readonly safetyReserveTokens: number
}

/**
 * Choose the smallest supported tier that can hold a request.
 * @param requestedTokens - Minimum context budget requested by the task.
 * @param hardLimit - Largest tier to return.
 * @returns The first fitting tier or undefined when the limit is too small.
 */
export function selectContextTier(requestedTokens: number, hardLimit: number = MAX_CONTEXT_TOKENS): ContextTier | undefined {
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) throw new TypeError('requestedTokens must be a positive safe integer')
  if (!Number.isSafeInteger(hardLimit) || hardLimit < 1) throw new TypeError('hardLimit must be a positive safe integer')
  return CONTEXT_TIERS.find(tier => tier >= requestedTokens && tier <= hardLimit)
}

/**
 * Return a conservative token budget for one worker request.
 * @param contextTokens - Supported context tier assigned to the task.
 * @param outputReserveTokens - Output tokens reserved for the worker response.
 * @param safetyReserveTokens - Additional tokens reserved for safety overhead.
 * @returns The task's context and output reserves.
 * @throws {TypeError} when a context tier or reserve is invalid.
 */
export function estimateTaskBudget(contextTokens: ContextTier, outputReserveTokens = 2_048, safetyReserveTokens = 1_024): TaskBudget {
  if (!CONTEXT_TIERS.includes(contextTokens)) throw new TypeError('contextTokens must be a supported context tier')
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
  if (!Number.isSafeInteger(policy.totalContextTokens) || policy.totalContextTokens < 0) throw new TypeError('totalContextTokens must be a non-negative safe integer')
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
    if (selected.length < slots && (policy.totalContextTokens === 0 || used + cost <= policy.totalContextTokens)) {
      selected.push(entry.task)
      used += cost
    } else {
      deferred.push(entry.task)
    }
  }
  return { selected, deferred }
}
