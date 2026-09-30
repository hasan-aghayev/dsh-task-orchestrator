/** Model-facing plan and report fields. @module */
import { TASK_ROLES } from './types.js'
import { CONTEXT_TIERS } from './adaptive.js'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

export const TOOL_PLAN_SCHEMA = {
  type: 'object',
  description: 'The task graph itself. Put summary, risk, requiresConfirmation, and tasks directly here; do not wrap them in another plan property.',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', required: true },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], required: true },
    requiresConfirmation: { type: 'boolean', required: true },
    tasks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          owner: { type: 'string', required: true, description: 'Unique worker label assigned to this task by the parent.' },
          role: { type: 'string', enum: [...TASK_ROLES], required: true },
          prompt: { type: 'string', required: true },
          dependsOn: { type: 'array', items: { type: 'string' }, required: true },
          readOnly: { type: 'boolean', required: true },
          writeScopes: { type: 'array', items: { type: 'string' }, required: true },
          contextBudget: { type: 'integer', enum: [...CONTEXT_TIERS] },
          outputReserveTokens: { type: 'integer' },
          safetyReserveTokens: { type: 'integer' },
          taskPackage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              taskId: { type: 'string', required: true },
              goal: { type: 'string', required: true },
              relevantContext: { type: 'array', items: { type: 'string' }, required: true },
              constraints: { type: 'array', items: { type: 'string' }, required: true },
              knownFacts: { type: 'array', items: { type: 'string' }, required: true },
              files: { type: 'array', items: { type: 'string' }, required: true },
              dependencies: { type: 'array', items: { type: 'string' }, required: true },
              expectedOutput: { type: 'string', required: true },
              doNot: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
        },
      },
    },
  },
} as const

export const WORKER_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed', 'needs_more_context'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    needs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['NEED_FILE', 'NEED_HISTORY', 'NEED_MORE_CONTEXT', 'NEED_DEPENDENCY', 'NEED_BUDGET', 'NEED_TOOL_RESULT', 'NEED_MORE_TOOL', 'NEED_REVIEW'] },
          reason: { type: 'string' },
          requestedContextTokens: { type: 'integer', enum: [...CONTEXT_TIERS] },
        },
        required: ['kind', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['taskId', 'status', 'summary', 'evidence', 'changedFiles', 'tests', 'blockers', 'nextSteps'],
  additionalProperties: false,
}

export const REVIEW_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'changes_requested', 'blocked', 'failed'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'findings', 'checks', 'nextSteps'],
  additionalProperties: false,
}
