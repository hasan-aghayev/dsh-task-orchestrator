// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InputHTMLAttributes, ButtonHTMLAttributes } from 'react'
import { ContextSettingsPage } from '../src/client/ContextSettingsPage.tsx'
import { inject as clientInject } from '../src/client/index.tsx'
import { SettingsNotice, SettingsNotices } from '../src/client/SettingsNotice.tsx'
import { readSettings, saveSettings, settingsError, type TaskOrchestratorSettings } from '../src/client/settings-model.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ContextSettingsLocaleKey } from '../src/client/locales.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'

const catalog: ModelCatalog = { default: { provider: 'local', model: 'think' }, routableProviders: ['local'], failures: [],
  groups: [{ id: 'local', name: 'Local', models: [
    { id: 'think', name: 'Reasoning model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    { id: 'plain', name: 'Plain model' },
  ] }],
}

// The Web shell supplies styled atoms; these tests exercise the plugin's form lifecycle.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant: string; size: string }) => <button {...props} />,
  Switch: ({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) => <button role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />,
  StateDot: () => <svg />,
  Toast: ({ text }: { text: string }) => <div role="alert">{text}</div>,
}))

afterEach(cleanup)
const t = (key: ContextSettingsLocaleKey) => en[key]

function fixture(options: { writable?: boolean; refusal?: boolean; failure?: boolean; value?: TaskOrchestratorSettings } = {}) {
  let snapshot: ConfigFormSnapshot<TaskOrchestratorSettings> = { status: 'ready', value: options.value ?? {}, base: {}, user: {}, revision: 7, writable: options.writable ?? true, mode: 'host' }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<ConfigFormSnapshot<TaskOrchestratorSettings>>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) }
  const mutate = vi.fn<ConfigForm<TaskOrchestratorSettings>['mutate']>(async ops => {
    if (options.failure) throw new Error('connection lost')
    if (options.refusal) return false
    const value = { ...snapshot.value }
    for (const op of ops) if (op.op === 'set') Object.assign(value, { [op.path[0]!]: op.value })
    publish({ value, revision: 8 }); return true
  })
  const form: ConfigForm<TaskOrchestratorSettings> = {
    getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate, set: async () => false, unset: async () => false,
  }
  const notices = new SettingsNotices()
  return { form, mutate, notices, publish, props: { form, t, notify: notices.publish, loadModels: vi.fn(async () => catalog) } }
}

describe('profile-backed orchestration settings', () => {
  it('injects the Session Remote used to load the model catalog', () => {
    expect(clientInject).toContain('remote.session')
  })

  it('saves edited fields together and displays the accepted Host values', async () => {
    const f = fixture()
    render(<ContextSettingsPage {...f.props} />)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(en.singleTitle, { selector: 'input[type=number]' }), { target: { value: '40001' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.notices.getSnapshot()?.kind).toBe('saved'))
    expect(f.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['maxWorkers'], value: 5 },
      { op: 'set', path: ['hardContextTokens'], value: 40001 },
    ], 7)
    expect((screen.getByLabelText(en.singleTitle, { selector: 'input[type=number]' }) as HTMLInputElement).value).toBe('40001')
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the draft after a refused write and keeps the notice after the page closes', async () => {
    const f = fixture({ refusal: true }), page = render(<ContextSettingsPage {...f.props} />)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.notices.getSnapshot()?.kind).toBe('saveFailed'))
    expect((screen.getByLabelText(en.maxWorkersTitle) as HTMLInputElement).value).toBe('5')
    page.unmount(); render(<SettingsNotice notices={f.notices} t={t} />)
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('reports connection failure without discarding edits', async () => {
    const f = fixture({ failure: true }); render(<ContextSettingsPage {...f.props} />)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.notices.getSnapshot()?.kind).toBe('saveFailed'))
    expect((screen.getByLabelText(en.maxWorkersTitle) as HTMLInputElement).value).toBe('5')
  })

  it('fences a dirty draft against edits in another window and reloads on request', () => {
    const f = fixture(); render(<ContextSettingsPage {...f.props} />)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '5' } })
    act(() => f.publish({ revision: 8, value: { maxWorkers: 4 } }))
    expect(screen.getByRole('status').textContent).toContain(en.conflict)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.reload }))
    expect((screen.getByLabelText(en.maxWorkersTitle) as HTMLInputElement).value).toBe('4')
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('refuses invalid combinations and shows unlimited without changing the other budget', () => {
    const f = fixture(); render(<ContextSettingsPage {...f.props} />)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '2' } })
    expect(screen.getByRole('alert').textContent).toBe(en.invalidWorkers)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText(en.totalTitle, { selector: 'input[type=number]' }), { target: { value: '0' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText(en.singleTitle, { selector: 'input[type=number]' }) as HTMLInputElement).value).toBe('65536')
    expect(screen.getAllByText(en.unlimited).length).toBeGreaterThan(1)
  })

  it('locks all editors in a read-only profile', () => {
    const f = fixture({ writable: false }); render(<ContextSettingsPage {...f.props} />)
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    for (const control of screen.getAllByRole('spinbutton')) expect((control as HTMLInputElement).disabled).toBe(true)
    for (const control of screen.getAllByRole('combobox')) expect((control as HTMLSelectElement).disabled).toBe(true)
  })

  it('preserves exact stored values and validates the queue, retry and context combinations', async () => {
    const baseline = readSettings({ hardContextTokens: 12345 })
    expect(baseline.hardContextTokens).toBe('12345')
    expect(settingsError({ ...baseline, maxChildStarts: '5' })).toBe('invalidStarts')
    expect(settingsError({ ...baseline, maxWorkers: '' })).toBe('invalidNumber')
    expect(settingsError({ ...baseline, totalContextTokens: '1000' })).toBe('invalidContext')
    expect(settingsError({ ...baseline, concurrencyByContext: [{ maxContextTokens: 1000, maxActiveGenerations: 2 }] })).toBe('invalidTiers')
    const f = fixture()
    expect(await saveSettings(f.form, { ...baseline, maxWorkers: '' }, baseline, 7)).toBe(false)
    expect(f.mutate).not.toHaveBeenCalled()
    expect(settingsError({ ...baseline, maxActiveGenerations: '1' })).toBeUndefined()
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })

  it('saves three models with independent supported reasoning levels in one profile write', async () => {
    const f = fixture(); render(<ContextSettingsPage {...f.props} />)
    await screen.findAllByRole('option', { name: 'Reasoning model' })
    for (const [label, reasoning, value] of [[en.orchestratorModel, en.orchestratorEffort, 'high'], [en.workerModel, en.workerEffort, 'low'], [en.reviewerModel, en.reviewerEffort, 'high']]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: JSON.stringify(['local', 'think']) } })
      fireEvent.change(screen.getByLabelText(reasoning), { target: { value } })
    }
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.notices.getSnapshot()?.kind).toBe('saved'))
    expect(f.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['orchestratorProvider'], value: 'local' }, { op: 'set', path: ['orchestratorModel'], value: 'think' }, { op: 'set', path: ['orchestratorReasoningEffort'], value: 'high' },
      { op: 'set', path: ['subagentLlmProvider'], value: 'local' }, { op: 'set', path: ['subagentModel'], value: 'think' }, { op: 'set', path: ['subagentReasoningEffort'], value: 'low' },
      { op: 'set', path: ['reviewerProvider'], value: 'local' }, { op: 'set', path: ['reviewerModel'], value: 'think' }, { op: 'set', path: ['reviewerReasoningEffort'], value: 'high' },
    ], 7)
  })

  it('clears stale effort when the model changes and preserves role choices when restoring queue defaults', async () => {
    const f = fixture({ value: { subagentLlmProvider: 'local', subagentModel: 'think', subagentReasoningEffort: 'high', maxWorkers: 4 } })
    render(<ContextSettingsPage {...f.props} />); await screen.findAllByRole('option', { name: 'Reasoning model' })
    fireEvent.click(screen.getByRole('button', { name: en.defaults }))
    expect((screen.getByLabelText(en.workerEffort) as HTMLSelectElement).value).toBe('high')
    expect((screen.getByLabelText(en.maxWorkersTitle) as HTMLInputElement).value).toBe('6')
    fireEvent.change(screen.getByLabelText(en.workerModel), { target: { value: JSON.stringify(['local', 'plain']) } })
    const effort = screen.getByLabelText(en.workerEffort) as HTMLSelectElement
    expect(effort.value).toBe(''); expect(effort.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.notices.getSnapshot()?.kind).toBe('saved'))
    expect(f.mutate.mock.calls[0][0]).toContainEqual({ op: 'set', path: ['subagentReasoningEffort'], value: '' })
  })

  it('retains unavailable assignments and unrelated drafts while model discovery fails and retries', async () => {
    const f = fixture({ value: { reviewerProvider: 'offline', reviewerModel: 'stored', reviewerReasoningEffort: 'deep' } })
    f.props.loadModels.mockRejectedValueOnce(new Error('offline'))
    render(<ContextSettingsPage {...f.props} />)
    await screen.findByText(en.modelsFailed)
    expect((screen.getByLabelText(en.reviewerModel) as HTMLSelectElement).value).toBe(JSON.stringify(['offline', 'stored']))
    fireEvent.change(screen.getByLabelText(en.maxWorkersTitle), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: en.refreshModels }))
    await screen.findAllByRole('option', { name: 'Reasoning model' })
    expect((screen.getByLabelText(en.maxWorkersTitle) as HTMLInputElement).value).toBe('5')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(f.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['maxWorkers'], value: 5 }], 7))
  })
})
