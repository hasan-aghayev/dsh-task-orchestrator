import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, scoreComplexity } from '../src/index.ts'
import { ResourceManager, estimateInputTokens } from '../src/resource-manager.ts'
import { CONTEXT_TIERS, estimateTaskBudget, packReadyTasks, selectContextTier } from '../src/adaptive.ts'

describe('DSH Task Orchestrator', () => {
  it('declares DSH 0.2.0-rc.2 compatibility for every required runtime package', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    for (const name of [
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/dsh-workflow',
    ]) {
      expect(manifest.peerDependencies[name]).toContain('^0.2.0-rc.2')
    }
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('^3.18.4')
    expect(manifest).not.toHaveProperty('packageManager')
    expect(manifest.scripts.prepare).toBe('pnpm build')
  })

  it('does not delegate a short, single-purpose request', () => {
    expect(scoreComplexity('Show the current branch')).toBeLessThan(55)
  })

  it('detects a multi-role request', () => {
    expect(scoreComplexity('Исследуй API, затем сделай backend и frontend, добавь тесты, документацию и финальное ревью.')).toBeGreaterThanOrEqual(55)
  })

  it('keeps the score bounded', () => {
    expect(scoreComplexity('frontend backend test docs review '.repeat(100))).toBeLessThanOrEqual(100)
  })

  it('keeps default context concurrency within the default global ceiling', () => {
    const defaults = Config({})
    expect(defaults.maxActiveGenerations.get()).toBe(2)
    expect(defaults.concurrencyByContext.get().every(tier => tier.maxActiveGenerations <= defaults.maxActiveGenerations.get())).toBe(true)
  })

  it('exposes queue and context settings without granting live edits to write permissions', () => {
    expect(Config.dict?.hardContextTokens?.meta.volatile).toBe(true)
    expect(Config.dict?.totalContextTokens?.meta.volatile).toBe(true)
    for (const field of ['mode', 'maxWorkers', 'maxConcurrentAgents', 'requireReview', 'maxActiveGenerations', 'maxChildStarts', 'maxAttemptsPerTask', 'concurrencyByContext']) expect(Config.dict?.[field]?.meta.volatile).toBe(true)
    expect(Config.dict?.allowWrites?.meta.volatile).toBeUndefined()
  })

  it('selects the smallest supported context tier through the 150K ceiling', () => {
    expect(selectContextTier(8_193)).toBe(16_384)
    expect(selectContextTier(65_537)).toBe(81_920)
    expect(selectContextTier(98_305)).toBe(99_328)
    expect(selectContextTier(149_505)).toBe(150_000)
    expect(CONTEXT_TIERS.slice(0, 8)).toEqual([8_192, 16_384, 24_576, 32_768, 49_152, 65_536, 81_920, 98_304])
    expect(CONTEXT_TIERS.at(-1)).toBe(150_000)
  })

  it('packs only the largest safe ready tasks into the available generation budget', () => {
    const task = (id: string, contextTokens: 8192 | 16384 | 24576) => ({
      task: { id, title: id, role: 'researcher' as const, prompt: id, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: contextTokens },
      budget: estimateTaskBudget(contextTokens, 0, 0),
      package: { taskId: id, goal: id, relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: [], expectedOutput: id, doNot: [] },
    })
    const result = packReadyTasks([task('large', 24_576), task('small-a', 8_192), task('small-b', 8_192)], { maxWorkers: 6, maxActiveGenerations: 2, totalContextTokens: 32_768, safetyReserveTokens: 0 })
    expect(result.selected.map(item => item.task.id)).toEqual(['large', 'small-a'])
    expect(result.deferred.map(item => item.task.id)).toEqual(['small-b'])
  })

  it('estimates prompt and tool text for the hard request limit', () => {
    const options = {
      provider: 'test', model: 'test', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(400) }] }],
      tools: [{ name: 'lookup', description: 'Read a file', parameters: { type: 'object' } }],
    } as never
    expect(estimateInputTokens(options)).toBeGreaterThanOrEqual(100)
  })

  it('rejects a request above the configured hard context limit', () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 10 })
    const context = { agents: { get: () => undefined } } as never
    expect(() => manager.stream(context, {
      provider: 'test', model: 'test', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(100) }] }],
    } as never, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })).toThrow(/exceeds hard context limit/)
  })

  it('uses updated context limits for streams created after settings change', () => {
    let hardContextTokens = 1_000
    let totalContextTokens = 1_000
    const manager = new ResourceManager({
      maxActiveGenerations: 1,
      hardContextTokens: () => hardContextTokens,
      totalContextTokens: () => totalContextTokens,
      safetyReserveTokens: 1,
    })
    const context = { agents: { get: () => undefined } } as never
    const options = {
      provider: 'test', model: 'test', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(400) }] }],
    } as never
    const next = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }

    hardContextTokens = 50
    expect(() => manager.stream(context, options, next)).toThrow(/exceeds hard context limit/)
    hardContextTokens = estimateInputTokens(options)
    totalContextTokens = hardContextTokens
    expect(() => manager.stream(context, options, next)).toThrow(/exceeds total context budget/)
  })

  it('limits consumed streams to the configured active lanes', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 2, hardContextTokens: 1000 })
    const context = { agents: { get: () => undefined } } as never
    let active = 0
    let peak = 0
    const stream = () => (async function* () {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'finish', reason: { kind: 'stop' } }
      active -= 1
    })()
    const requests = Array.from({ length: 4 }, () => manager.stream(context, { provider: 'test', model: 'test', messages: [] }, stream))
    await Promise.all(requests.map(async request => { for await (const _chunk of request) { /* consume */ } }))
    expect(peak).toBe(2)
    expect(manager.activeGenerations).toBe(0)
    expect(manager.queuedGenerations).toBe(0)
  })

  it('raises concurrency for small requests while preserving the shared budget', async () => {
    const manager = new ResourceManager({
      maxActiveGenerations: 6,
      hardContextTokens: 8_192,
      totalContextTokens: 10_000,
      concurrencyByContext: [{ maxContextTokens: 8_192, maxActiveGenerations: 6 }],
    })
    const context = { agents: { get: () => undefined } } as never
    let active = 0
    let peak = 0
    const stream = () => (async function* () {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'finish', reason: { kind: 'stop' } }
      active -= 1
    })()
    const requests = Array.from({ length: 6 }, () => manager.stream(context, { provider: 'test', model: 'test', messages: [] }, stream))
    await Promise.all(requests.map(async request => { for await (const _chunk of request) { /* consume */ } }))
    expect(peak).toBe(6)
    expect(manager.activeGenerations).toBe(0)
    expect(manager.activeContextBudget).toBe(0)
  })

  it('removes an aborted request that is waiting for a lane', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 1000 })
    const context = { agents: { get: () => undefined } } as never
    let unblock!: () => void
    const first = manager.stream(context, { provider: 'test', model: 'test', messages: [] }, () => (async function* () {
      await new Promise<void>(resolve => { unblock = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const firstDone = (async () => { for await (const _chunk of first) { /* consume */ } })()
    await Promise.resolve()
    await Promise.resolve()
    const controller = new AbortController()
    const second = manager.stream(context, { provider: 'test', model: 'test', messages: [], signal: controller.signal }, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const secondDone = (async () => { for await (const _chunk of second) { /* consume */ } })()
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.queuedGenerations).toBe(1)
    controller.abort()
    await expect(secondDone).rejects.toThrow(/cancelled while waiting/)
    expect(manager.queuedGenerations).toBe(0)
    unblock()
    await firstDone
    expect(manager.activeGenerations).toBe(0)
  })

  it('enables the workflow engine required by the bundle', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(patch).toContain('id: task-orchestrator-workflow')
    expect(patch).toContain("name: '@deepseek-ai/dsh-workflow-ptc'")
    expect(patch).toContain('provider: spawn')
  })

  it('owns the model-facing delegation tools in one disableable group', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(patch).toContain('- id: task-orchestrator-suite')
    expect(patch).toContain('name: cordis:group')
    expect(patch).toContain('workflowEngine: true')
    for (const id of [
      'task-orchestrator-tool-subagent-control',
      'task-orchestrator-tool-subagent-list-agents',
      'task-orchestrator-tool-subagent',
      'task-orchestrator-tool-subagent-fork',
      'task-orchestrator-workflow',
    ]) {
      expect(patch).toContain(`- id: ${id}`)
    }
    expect(patch).toContain('toolName: subagent')
    expect(patch).toContain('toolName: subagent_fork')
    for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']) {
      expect(patch).toContain(`- id: ${id}\n  disabled: true`)
    }
  })


})
