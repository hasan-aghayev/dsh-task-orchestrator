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
  readonly maxActiveGenerations: number
  /** Hard estimated input-token limit including prompt and tool descriptions. */
  readonly hardContextTokens: number
  /** Time a queued request needs before its priority is raised by one level. */
  readonly priorityAgingMs?: number
}

interface Waiter {
  readonly options: GenerateOptions
  readonly next: () => AsyncIterable<StreamChunk>
  resolve: () => void
  reject: (error: unknown) => void
  readonly signal?: AbortSignal
  readonly priority: number
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
    characters += message.role.length + message.id.length + 16
    characters += message.content.reduce((total, block) => {
      if (block.type === 'text' || block.type === 'reasoning') return total + block.text.length
      if (block.type === 'tool-call') return total + block.name.length + block.arguments.length
      return total + 32
    }, 0)
  }
  for (const tool of options.tools ?? []) characters += tool.name.length + tool.description.length + (JSON.stringify(tool.parameters)?.length ?? 32) + 32
  return Math.ceil(characters / 3)
}

/** Queue and consume model streams while preserving the provider stream contract. */
export class ResourceManager {
  private readonly queue: Waiter[] = []
  private active = 0
  private sequence = 0
  private readonly priorityAgingMs: number

  constructor(private readonly config: ResourceManagerConfig) {
    if (!Number.isSafeInteger(config.maxActiveGenerations) || config.maxActiveGenerations < 1) throw new TypeError('maxActiveGenerations must be a positive safe integer')
    if (!Number.isSafeInteger(config.hardContextTokens) || config.hardContextTokens < 1) throw new TypeError('hardContextTokens must be a positive safe integer')
    this.priorityAgingMs = config.priorityAgingMs ?? 30_000
    if (!Number.isSafeInteger(this.priorityAgingMs) || this.priorityAgingMs < 1) throw new TypeError('priorityAgingMs must be a positive safe integer')
  }

  /** Number of streams currently consuming provider output. */
  get activeGenerations(): number { return this.active }

  /** Number of requests waiting for a model lane. */
  get queuedGenerations(): number { return this.queue.length }

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
    if (estimated > this.config.hardContextTokens) {
      throw new Error(`model request estimate ${estimated} tokens exceeds hard context limit ${this.config.hardContextTokens}`)
    }
    const priority = options.sessionId !== undefined && ctx.agents.get(options.sessionId)?.session.header.origin === 'subagent' ? 1 : 0
    return this.consume({ options, next, priority, signal: options.signal })
  }

  private consume(waiter: Admission): AsyncIterable<StreamChunk> {
    const manager = this
    return {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<StreamChunk> {
        await manager.acquire(waiter)
        try {
          for await (const chunk of waiter.next()) yield chunk
        } finally {
          manager.release()
        }
      },
    }
  }

  private acquire(input: Admission): Promise<void> {
    if (input.signal?.aborted) return Promise.reject(new Error('model request cancelled before queue admission'))
    if (this.active < this.config.maxActiveGenerations) {
      this.active += 1
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
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.resolve = () => {
        input.signal?.removeEventListener('abort', onAbort)
        if (waiter.settled) return
        waiter.settled = true
        this.active += 1
        resolve()
      }
      waiter.reject = (error: unknown) => {
        input.signal?.removeEventListener('abort', onAbort)
        if (waiter.settled) return
        waiter.settled = true
        reject(error)
      }
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const nextIndex = this.nextQueueIndex()
    const next = nextIndex === undefined ? undefined : this.queue.splice(nextIndex, 1)[0]
    if (next === undefined) return
    next.resolve()
  }

  private nextQueueIndex(): number | undefined {
    if (this.queue.length === 0) return undefined
    const now = Date.now()
    let bestIndex = 0
    let bestRank = Number.POSITIVE_INFINITY
    let bestSequence = Number.POSITIVE_INFINITY
    for (let index = 0; index < this.queue.length; index += 1) {
      const waiter = this.queue[index]
      if (waiter === undefined) continue
      const ageBoost = Math.floor(Math.max(0, now - waiter.enqueuedAt) / this.priorityAgingMs)
      const rank = waiter.priority - ageBoost
      if (rank < bestRank || rank === bestRank && waiter.sequence < bestSequence) {
        bestIndex = index
        bestRank = rank
        bestSequence = waiter.sequence
      }
    }
    return bestIndex
  }
}
