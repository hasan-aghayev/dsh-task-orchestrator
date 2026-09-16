import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scoreComplexity } from '../src/index.ts'

describe('DSH Task Orchestrator', () => {
  it('does not delegate a short, single-purpose request', () => {
    expect(scoreComplexity('Show the current branch')).toBeLessThan(55)
  })

  it('detects a multi-role request', () => {
    expect(scoreComplexity('Исследуй API, затем сделай backend и frontend, добавь тесты, документацию и финальное ревью.')).toBeGreaterThanOrEqual(55)
  })

  it('keeps the score bounded', () => {
    expect(scoreComplexity('frontend backend test docs review '.repeat(100))).toBeLessThanOrEqual(100)
  })

  it('enables the workflow engine required by the bundle', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: task-orchestrator-workflow')
    expect(patch).toContain("name: '@deepseek-ai/dsh-workflow-ptc'")
    expect(patch).toContain('provider: spawn')
  })

  it('owns the model-facing delegation tools in one disableable group', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
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
