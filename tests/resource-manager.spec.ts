import { describe, expect, it } from 'vitest'
import { ResourceManager } from '../src/resource-manager.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

const ctx = { agents: { get: () => undefined } } as never
const small: GenerateOptions = { provider: 'test', model: 'test', messages: [] }
const large = { ...small, system: 'x'.repeat(2_000) }

function lane(manager: ResourceManager, options = small) {
  const entered = deferred(), release = deferred()
  const iterable = manager.stream(ctx, options, async function* (): AsyncGenerator<StreamChunk> {
    entered.resolve()
    await release.promise
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const done = (async () => { for await (const _chunk of iterable) { /* consume */ } })()
  return { entered: entered.promise, release: release.resolve, done }
}

function manager() {
  return new ResourceManager({ maxActiveGenerations: 2, hardContextTokens: 1_000, totalContextTokens: 2_000,
    concurrencyByContext: [{ maxContextTokens: 100, maxActiveGenerations: 2 }, { maxContextTokens: 1_000, maxActiveGenerations: 1 }],
  })
}

describe('shared local model lanes', () => {
  it('rejects waiting input above a reduced hard limit before it reaches the provider', async () => {
    let hard = 1_000
    const scheduler = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: () => hard,
      totalContextTokens: 2_000, concurrencyByContext: [{ maxContextTokens: 1_000, maxActiveGenerations: 2 }] })
    const first = lane(scheduler), second = lane(scheduler, large)
    const rejection = expect(second.done).rejects.toThrow(/updated hard context limit 100/)
    await first.entered; hard = 100
    first.release(); await first.done; await rejection
    expect(scheduler.queuedGenerations).toBe(0)
  })

  it('refuses invalid live context ranges before creating a provider request', () => {
    let tiers = [{ maxContextTokens: 1_000, maxActiveGenerations: 2 }]
    const scheduler = new ResourceManager({ maxActiveGenerations: 2, hardContextTokens: 1_000, concurrencyByContext: () => tiers })
    tiers = [{ maxContextTokens: 1_000, maxActiveGenerations: 2 }, { maxContextTokens: 100, maxActiveGenerations: 2 }]
    expect(() => scheduler.stream(ctx, small, async function* () {})).toThrow(/sorted/)
  })
  it('uses a saved global limit for later admissions without cancelling active requests', async () => {
    let limit = 2
    let tiers = [{ maxContextTokens: 1_000, maxActiveGenerations: 2 }]
    const scheduler = new ResourceManager({ maxActiveGenerations: () => limit, hardContextTokens: 1_000,
      totalContextTokens: 2_000, concurrencyByContext: () => tiers })
    const first = lane(scheduler), second = lane(scheduler)
    await Promise.all([first.entered, second.entered])
    limit = 1
    const third = lane(scheduler)
    expect(scheduler.activeGenerations).toBe(2)
    first.release(); await first.done
    expect(scheduler.queuedGenerations).toBe(1)
    second.release(); await second.done; await third.entered
    tiers = [{ maxContextTokens: 1_000, maxActiveGenerations: 1 }]
    limit = 2
    const fourth = lane(scheduler)
    expect(scheduler.queuedGenerations).toBe(1)
    third.release(); await third.done; await fourth.entered
    expect(scheduler.activeGenerations).toBe(1)
    fourth.release(); await fourth.done
  })
  it('preserves the limit of an already active large request and drains two waiting small requests', async () => {
    const scheduler = manager(), first = lane(scheduler, large)
    await first.entered
    const second = lane(scheduler), third = lane(scheduler)
    expect(scheduler.activeGenerations).toBe(1); expect(scheduler.queuedGenerations).toBe(2)
    first.release(); await first.done
    await Promise.all([second.entered, third.entered])
    expect(scheduler.activeGenerations).toBe(2); expect(scheduler.queuedGenerations).toBe(0)
    second.release(); third.release(); await Promise.all([second.done, third.done])
    expect(scheduler.activeGenerations).toBe(0); expect(scheduler.activeContextBudget).toBe(0)
  })

  it('does not start a large request beside an already active small request', async () => {
    const scheduler = manager(), first = lane(scheduler)
    await first.entered
    const second = lane(scheduler, large)
    expect(scheduler.queuedGenerations).toBe(1)
    first.release(); await first.done; await second.entered
    expect(scheduler.activeGenerations).toBe(1)
    second.release(); await second.done
  })

  it('counts the actual output reserve and rejects a child above its assigned budget', () => {
    const scheduler = new ResourceManager({ maxActiveGenerations: 2, hardContextTokens: 10_000, totalContextTokens: 20_000,
      requestBudget: () => ({ contextTokens: 1_000, safetyReserveTokens: 100 }),
    })
    expect(() => scheduler.stream(ctx, { ...large, maxTokens: 500 }, async function* () {})).toThrow(/assigned context budget/)
    expect(() => scheduler.stream(ctx, { ...small, maxTokens: 500 }, async function* () {})).not.toThrow()
  })

  it('rejects queued requests and delayed consumers after unload', async () => {
    const scheduler = manager(), first = lane(scheduler, large)
    await first.entered
    const second = lane(scheduler)
    const rejected = expect(second.done).rejects.toThrow(/unloaded/)
    scheduler.close(); await rejected
    await expect(lane(scheduler).done).rejects.toThrow(/unloaded/)
    first.release(); await first.done
    expect(scheduler.queuedGenerations).toBe(0)
  })
})
