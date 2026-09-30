/** Profile values and validation shared by the Settings page and its form tests. @module */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigValues, ContextConcurrency, OrchestrationMode } from '../index.js'

/** Editable fields projected by the Host configuration form. */
export type TaskOrchestratorSettings = Pick<ConfigValues, 'mode' | 'maxWorkers' | 'maxConcurrentAgents'
  | 'requireReview' | 'maxActiveGenerations' | 'maxChildStarts' | 'maxAttemptsPerTask'
  | 'concurrencyByContext' | 'hardContextTokens' | 'totalContextTokens'>

/** Fully populated draft; numbers are edited as text so empty and invalid inputs remain visible. */
export interface SettingsDraft {
  mode: OrchestrationMode
  maxWorkers: string
  maxConcurrentAgents: string
  requireReview: boolean
  maxActiveGenerations: string
  maxChildStarts: string
  maxAttemptsPerTask: string
  hardContextTokens: string
  totalContextTokens: string
  concurrencyByContext: ContextConcurrency[]
}

/** Localized validation messages for combinations that the scheduler cannot execute. */
export type SettingsError = 'invalidNumber' | 'invalidWorkers' | 'invalidStarts' | 'invalidContext' | 'invalidTiers'

/** Convert a Host view to an independent editable draft without rounding persisted token values.
 * @param value - latest schema-resolved Host fields.
 * @returns independent staged values.
 */
export function readSettings(value: TaskOrchestratorSettings | undefined): SettingsDraft {
  return {
    mode: value?.mode ?? 'hybrid', maxWorkers: String(value?.maxWorkers ?? 6),
    maxConcurrentAgents: String(value?.maxConcurrentAgents ?? 2), requireReview: value?.requireReview ?? true,
    maxActiveGenerations: String(value?.maxActiveGenerations ?? 2),
    maxChildStarts: String(value?.maxChildStarts ?? 12), maxAttemptsPerTask: String(value?.maxAttemptsPerTask ?? 2),
    hardContextTokens: String(value?.hardContextTokens ?? 65_536), totalContextTokens: String(value?.totalContextTokens ?? 98_304),
    concurrencyByContext: (value?.concurrencyByContext ?? [
      { maxContextTokens: 8_192, maxActiveGenerations: 2 }, { maxContextTokens: 16_384, maxActiveGenerations: 2 },
      { maxContextTokens: 24_576, maxActiveGenerations: 2 }, { maxContextTokens: 32_768, maxActiveGenerations: 2 },
      { maxContextTokens: 49_152, maxActiveGenerations: 2 }, { maxContextTokens: 65_536, maxActiveGenerations: 1 },
      { maxContextTokens: 81_920, maxActiveGenerations: 1 }, { maxContextTokens: 98_304, maxActiveGenerations: 1 },
      { maxContextTokens: 150_000, maxActiveGenerations: 1 },
    ]).map(tier => ({ ...tier })),
  }
}

/** Check a draft before submitting one atomic Host mutation.
 * @param draft - staged values, including unparsed number input.
 * @returns localized error key, or undefined when the draft can be saved.
 */
export function settingsError(draft: SettingsDraft): SettingsError | undefined {
  const fields = ['maxWorkers', 'maxConcurrentAgents', 'maxActiveGenerations', 'maxChildStarts', 'maxAttemptsPerTask', 'hardContextTokens', 'totalContextTokens'] as const
  if (fields.some(key => !/^\d+$/.test(draft[key]) || !Number.isSafeInteger(Number(draft[key])))) return 'invalidNumber'
  const workers = Number(draft.maxWorkers), concurrent = Number(draft.maxConcurrentAgents)
  if (workers > 6 || workers < 2 + Number(draft.requireReview) || concurrent < 2 || concurrent > workers) return 'invalidWorkers'
  const starts = Number(draft.maxChildStarts), attempts = Number(draft.maxAttemptsPerTask), streams = Number(draft.maxActiveGenerations)
  if (starts < workers || starts > 48 || attempts < 1 || attempts > 8 || streams < 1) return 'invalidStarts'
  const hard = Number(draft.hardContextTokens), total = Number(draft.totalContextTokens)
  if (total > 0 && hard > total) return 'invalidContext'
  let previous = 0
  for (const tier of draft.concurrencyByContext) {
    if (!Number.isSafeInteger(tier.maxContextTokens) || tier.maxContextTokens <= previous || !Number.isSafeInteger(tier.maxActiveGenerations) || tier.maxActiveGenerations < 1) return 'invalidTiers'
    previous = tier.maxContextTokens
  }
  if (draft.concurrencyByContext.length === 0 || hard > previous) return 'invalidTiers'
  return undefined
}

/** Persist only edited fields; preserve other plugin configuration and the revision fence.
 * @param form - profile-backed Host form.
 * @param draft - staged settings.
 * @param baseline - settings read at the start of editing.
 * @param revision - Host revision that must still be current.
 * @returns whether the Host accepted the atomic write.
 */
export function saveSettings(form: ConfigForm<TaskOrchestratorSettings>, draft: SettingsDraft, baseline: SettingsDraft, revision: number): Promise<boolean> {
  if (settingsError(draft) !== undefined) return Promise.resolve(false)
  const values: Required<TaskOrchestratorSettings> = {
    ...draft, maxWorkers: Number(draft.maxWorkers), maxConcurrentAgents: Number(draft.maxConcurrentAgents),
    maxActiveGenerations: Number(draft.maxActiveGenerations), maxChildStarts: Number(draft.maxChildStarts), maxAttemptsPerTask: Number(draft.maxAttemptsPerTask),
    hardContextTokens: Number(draft.hardContextTokens), totalContextTokens: Number(draft.totalContextTokens),
  }
  const keys = Object.keys(values) as Array<keyof Required<TaskOrchestratorSettings>>
  const ops = keys.filter(key => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]))
    .map(key => ({ op: 'set' as const, path: [key], value: values[key] }))
  return ops.length === 0 ? Promise.resolve(true) : form.mutate(ops, revision)
}
