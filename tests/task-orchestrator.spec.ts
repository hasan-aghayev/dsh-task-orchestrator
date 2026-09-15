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
})
