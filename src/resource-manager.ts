/**
 * Bounded model-request scheduler for one resident NInfer process.
 *
 * Logical Agents can outnumber the model's active generation lanes. This
 * scheduler owns only the short interval while a model stream is consumed;
 * tools, filesystem work, and an Agent waiting for children do not hold a
 * lane. Queue entries are released in priority/FIFO order and cancellation
 * removes an entry before it reaches the provider.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Runtime policy for the local model request scheduler. */
export interface ResourceManagerConfig {
  /** Maximum concurrently consumed generation streams. */
  readonly maxActiveGenerations: number | (() => number)
  /** Hard estimated input-token limit; zero disables this check. A getter keeps live settings current. */
  readonly hardContextTokens: number | (() => number)
  /** Total estimated input/output budget; zero disables the shared budget check. A getter keeps live settings current. */
  readonly totalContextTokens?: number | (() => number)
  /** Per-request concurrency ceilings selected by estimated input size. */
  readonly concurrencyByContext?: readonly ContextConcurrencyLimit[] | (() => readonly ContextConcurrencyLimit[])
  /** Output reserve used when a request does not declare maxTokens. */
  readonly defaultOutputReserveTokens?: number
  /** Fixed safety reserve included in every admission cost. */
  readonly safetyReserveTokens?: number
  /** Time a queued request needs before its priority is raised by one level. */
  readonly priorityAgingMs?: number
  /** Budget assigned during creation of an isolated orchestration child. */
  readonly requestBudget?: (options: GenerateOptions) => { contextTokens: number; safetyReserveTokens: number } | undefined
  /** Preserve scheduler-owned numeric diagnostics when a provider omits its failure detail. */
  readonly onRejectedRequest?: (options: GenerateOptions, reason: string) => void
}

/** One context range and its maximum number of active streams. */
export interface ContextConcurrencyLimit {
  readonly maxContextTokens: number
  readonly maxActiveGenerations: number
}

/** Validate configured context ranges at load and before consuming live edits.
 * @param tiers - ranges in increasing order.
 * @param hardContextTokens - input limit that must be covered; zero removes that coverage requirement.
 */
export function validateContextConcurrency(tiers: readonly ContextConcurrencyLimit[], hardContextTokens: number): void {
  let previous = 0
  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.maxContextTokens) || tier.maxContextTokens <= previous) throw new TypeError('concurrencyByContext must be sorted by increasing maxContextTokens')
    if (!Number.isSafeInteger(tier.maxActiveGenerations) || tier.maxActiveGenerations < 1) throw new TypeError('concurrencyByContext has an invalid maxActiveGenerations value')
    previous = tier.maxContextTokens
  }
  if (tiers.length === 0 || hardContextTokens > 0 && previous < hardContextTokens) throw new TypeError('concurrencyByContext must cover hardContextTokens')
}

interface Waiter {
  readonly options: GenerateOptions
  readonly next: () => AsyncIterable<StreamChunk>
  resolve: () => void
  reject: (error: unknown) => void
  readonly signal?: AbortSignal
  readonly priority: number
  readonly cost: number
  readonly inputTokens: number
  readonly maxActiveGenerations: number
  readonly sequence: number
  readonly enqueuedAt: number
  settled: boolean
}

type Admission = Omit<Waiter, 'resolve' | 'reject' | 'settled' | 'sequence' | 'enqueuedAt'>

/**
 * Estimate request input size before the provider performs tokenization.
 * This is a guard against accidental oversized requests, not a replacement
 * for the provider's authoritative tokenizer.
 * @param options - provider-neutral model request.
 * @returns an intentionally conservative token estimate.
 */
export function estimateInputTokens(options: GenerateOptions): number {
  let characters = options.system?.length ?? 0
  for (const message of options.messages) {
    characters += message.role.length + (message.id?.length ?? 0) + 16
    characters += message.content.reduce((total, block) => {
      if (block.type === 'text' || block.type === 'reasoning') return total + block.text.length
      if (block.type === 'tool-call') return total + block.name.length + block.arguments.length
      return total + 32
    }, 0)
  }
  for (const tool of options.tools ?? []) characters += tool.name.length + tool.description.length + (JSON.stringify(tool.parameters)?.length ?? 32) + 32
  // English and Russian prose in the active Qwen tokenizer averages close to
  // four characters per token. This estimate remains conservative because
  // role/id/tool overhead is counted above; NInfer still performs the exact
  // admission check after tokenization.
  return Math.ceil(characters / 4)
}

/** Queue and consume model streams while preserving the provider stream contract. */
export class ResourceManager {
  private readonly queue: Waiter[] = []
  private active = 0
  private activeContextTokens = 0
  private readonly activeLimits = new Map<Admission, number>()
  private sequence = 0
  private closed = false
  private readonly priorityAgingMs: number
  private readonly hardContextTokens: () => number
  private readonly totalContextTokens: () => number
  private readonly concurrencyByContext: () => readonly ContextConcurrencyLimit[]
  private readonly maxActiveGenerations: () => number
  private readonly defaultOutputReserveTokens: number
  private readonly safetyReserveTokens: number

  constructor(private readonly config: ResourceManagerConfig) {
    this.maxActiveGenerations = numberReader(config.maxActiveGenerations)
    const maxActiveGenerations = this.maxActiveGenerations()
    if (!Number.isSafeInteger(maxActiveGenerations) || maxActiveGenerations < 1) throw new TypeError('maxActiveGenerations must be a positive safe integer')
    this.hardContextTokens = numberReader(config.hardContextTokens)
    this.totalContextTokens = numberReader(config.totalContextTokens ?? config.hardContextTokens)
    const hardContextTokens = this.hardContextTokens()
    const totalContextTokens = this.totalContextTokens()
    if (!Number.isSafeInteger(hardContextTokens) || hardContextTokens < 0) throw new TypeError('hardContextTokens must be a non-negative safe integer')
    if (!Number.isSafeInteger(totalContextTokens) || totalContextTokens < 0) throw new TypeError('totalContextTokens must be a non-negative safe integer')
    if (totalContextTokens > 0 && totalContextTokens < hardContextTokens) throw new TypeError('totalContextTokens cannot be below hardContextTokens unless it is zero')
    this.defaultOutputReserveTokens = config.defaultOutputReserveTokens ?? 0
    this.safetyReserveTokens = config.safetyReserveTokens ?? 0
    if (!Number.isSafeInteger(this.defaultOutputReserveTokens) || this.defaultOutputReserveTokens < 0) throw new TypeError('defaultOutputReserveTokens must be a non-negative safe integer')
    if (!Number.isSafeInteger(this.safetyReserveTokens) || this.safetyReserveTokens < 0) throw new TypeError('safetyReserveTokens must be a non-negative safe integer')
    const configuredTiers = config.concurrencyByContext
    this.concurrencyByContext = typeof configuredTiers === 'function' ? configuredTiers : () => configuredTiers ?? [{ maxContextTokens: hardContextTokens, maxActiveGenerations }]
    const tiers = this.concurrencyByContext()
    validateContextConcurrency(tiers, hardContextTokens)
    this.priorityAgingMs = config.priorityAgingMs ?? 30_000
    if (!Number.isSafeInteger(this.priorityAgingMs) || this.priorityAgingMs < 1) throw new TypeError('priorityAgingMs must be a positive safe integer')
  }

  /** Number of streams currently consuming provider output. */
  get activeGenerations(): number { return this.active }

  /** Number of requests waiting for a model lane. */
  get queuedGenerations(): number { return this.queue.length }

  /** Estimated context budget held by active streams. */
  get activeContextBudget(): number { return this.activeContextTokens }

  /**
   * Wrap one waterfall request. The returned iterable acquires a lane only
   * when consumption starts and releases it after EOF, cancellation, or error.
   * @param ctx - DSH context used to identify a subagent request.
   * @param options - provider-neutral request.
   * @param next - downstream provider stream.
   * @returns a stream with bounded admission.
   */
  stream(ctx: Context, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const estimated = estimateInputTokens(options)
    const hardContextTokens = this.hardContextTokens()
    const totalContextTokens = this.totalContextTokens()
    validateContextConcurrency(this.concurrencyByContext(), hardContextTokens)
    if (!Number.isSafeInteger(hardContextTokens) || hardContextTokens < 0) throw new TypeError('hardContextTokens must be a non-negative safe integer')
    if (!Number.isSafeInteger(totalContextTokens) || totalContextTokens < 0) throw new TypeError('totalContextTokens must be a non-negative safe integer')
    if (totalContextTokens > 0 && totalContextTokens < hardContextTokens) throw new TypeError('totalContextTokens cannot be below hardContextTokens unless it is zero')
    if (hardContextTokens > 0 && estimated > hardContextTokens) {
      throw this.rejection(options, `model request estimate ${estimated} tokens exceeds hard context limit ${hardContextTokens}`)
    }
    const budget = this.config.requestBudget?.(options)
    const safety = budget?.safetyReserveTokens ?? this.safetyReserveTokens
    const cost = estimated + (options.maxTokens ?? this.defaultOutputReserveTokens) + safety
    if (budget !== undefined && cost > budget.contextTokens) throw this.rejection(options, `worker request cost ${cost} tokens exceeds assigned context budget ${budget.contextTokens}; return NEED_BUDGET to the parent`)
    if (!Number.isSafeInteger(cost) || totalContextTokens > 0 && cost > totalContextTokens) throw this.rejection(options, `model request cost ${cost} tokens exceeds total context budget ${totalContextTokens}`)
    const maxActiveGenerations = this.limitFor(estimated)
    const priority = options.sessionId !== undefined && ctx.agents.get(options.sessionId)?.session.header.origin === 'subagent' ? 1 : 0
    return this.consume({
      options,
      next,
      priority,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cost,
      inputTokens: estimated,
      maxActiveGenerations,
    })
  }

  private rejection(options: GenerateOptions, reason: string): Error {
    this.config.onRejectedRequest?.(options, reason)
    return new Error(reason)
  }

  /** Choose the first configured concurrency range that contains an estimate. */
  private limitFor(estimated: number): number {
    return this.concurrencyByContext().find(tier => estimated <= tier.maxContextTokens)?.maxActiveGenerations ?? 1
  }

  private consume(waiter: Admission): AsyncIterable<StreamChunk> {
    const manager = this
    return {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<StreamChunk> {
        await manager.acquire(waiter)
        try {
          for await (const chunk of waiter.next()) yield chunk
        } finally {
          manager.release(waiter)
        }
      },
    }
  }

  private acquire(input: Admission): Promise<void> {
    if (this.closed) return Promise.reject(new Error('task-orchestrator scheduler unloaded'))
    if (input.signal?.aborted) return Promise.reject(new Error('model request cancelled before queue admission'))
    if (this.queue.length === 0 && this.canAdmit(input)) {
      this.active += 1
      this.activeContextTokens += input.cost
      this.activeLimits.set(input, input.maxActiveGenerations)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { ...input, resolve, reject, settled: false, sequence: this.sequence++, enqueuedAt: Date.now() }
      this.queue.push(waiter)
      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new Error('model request cancelled while waiting for queue admission'))
        this.drain()
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.resolve = () => {
        input.signal?.removeEventListener('abort', onAbort)
        if (waiter.settled) return
        waiter.settled = true
        this.active += 1
        this.activeContextTokens += waiter.cost
        this.activeLimits.set(input, waiter.maxActiveGenerations)
        resolve()
      }
      waiter.reject = (error: unknown) => {
        input.signal?.removeEventListener('abort', onAbort)
        if (waiter.settled) return
        waiter.settled = true
        reject(error)
      }
      this.drain()
    })
  }

  private release(input: Admission): void {
    this.active = Math.max(0, this.active - 1)
    this.activeContextTokens = Math.max(0, this.activeContextTokens - input.cost)
    this.activeLimits.delete(input)
    this.drain()
  }

  /** Reject waiting work when the plugin is unloaded. Active streams keep their caller cancellation. */
  close(): void {
    this.closed = true
    for (const waiter of this.queue.splice(0)) waiter.reject(new Error('task-orchestrator scheduler unloaded'))
  }

  private drain(): void {
    const total = this.totalContextTokens()
    const hard = this.hardContextTokens()
    if (total > 0 || hard > 0) {
      for (const waiter of [...this.queue]) {
        const reason = hard > 0 && waiter.inputTokens > hard
          ? `queued request input ${waiter.inputTokens} tokens exceeds updated hard context limit ${hard}`
          : total > 0 && waiter.cost > total ? `queued request cost ${waiter.cost} tokens exceeds updated total context budget ${total}` : undefined
        if (reason === undefined) continue
        this.queue.splice(this.queue.indexOf(waiter), 1)
        waiter.reject(this.rejection(waiter.options, reason))
      }
    }
    for (let nextIndex = this.nextQueueIndex(); nextIndex !== undefined; nextIndex = this.nextQueueIndex()) {
      this.queue.splice(nextIndex, 1)[0]!.resolve()
    }
  }

  private nextQueueIndex(): number | undefined {
    if (this.queue.length === 0) return undefined
    const now = Date.now()
    let bestIndex = 0
    let bestRank = Number.POSITIVE_INFINITY
    let bestSequence = Number.POSITIVE_INFINITY
    let found = false
    const oldest = [...this.queue].sort((left, right) => {
      const rank = (waiter: Waiter): number => waiter.priority - Math.floor(Math.max(0, now - waiter.enqueuedAt) / this.priorityAgingMs)
      return rank(left) - rank(right) || left.sequence - right.sequence
    })[0]!
    if (now - oldest.enqueuedAt >= this.priorityAgingMs && !this.canAdmit(oldest)) return undefined
    for (let index = 0; index < this.queue.length; index += 1) {
      const waiter = this.queue[index]
      if (waiter === undefined) continue
      if (!this.canAdmit(waiter)) continue
      const ageBoost = Math.floor(Math.max(0, now - waiter.enqueuedAt) / this.priorityAgingMs)
      const rank = waiter.priority - ageBoost
      if (rank < bestRank || rank === bestRank && waiter.sequence < bestSequence) {
        bestIndex = index
        bestRank = rank
        bestSequence = waiter.sequence
        found = true
      }
    }
    return found ? bestIndex : undefined
  }

  private canAdmit(input: Admission): boolean {
    return this.active < Math.min(this.maxActiveGenerations(), input.maxActiveGenerations, this.limitFor(input.inputTokens), ...this.activeLimits.values())
      && (this.totalContextTokens() === 0 || this.activeContextTokens + input.cost <= this.totalContextTokens())
  }
}

/** Read a fixed limit or the current value from a live-settings getter. */
function numberReader(value: number | (() => number)): () => number {
  return typeof value === 'function' ? value : () => value
}
