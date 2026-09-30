/** Profile-backed controls for parent planning, task execution and the local model queue. @module */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Input, Switch, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextSettingsLocaleKey } from './locales.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { MODEL_ROLES, modelSettingsError, readSettings, saveSettings, settingsError, type SettingsDraft, type TaskOrchestratorSettings } from './settings-model.js'

export type { TaskOrchestratorSettings } from './settings-model.js'

/** Services supplied by the Settings registration; notices outlive the page. */
export interface ContextSettingsInjected {
  form: ConfigForm<TaskOrchestratorSettings>
  notify: (kind: 'saved' | 'saveFailed') => void
  /** Native DSH model catalog, including adapter-owned reasoning levels. */
  loadModels: () => Promise<ModelCatalog>
}

/** Form, locale and Settings section props assembled by DSH. */
export type ContextSettingsPageProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.task-orchestrator'> & InjectFace<ContextSettingsInjected>

const MAX_TOKENS = 150_000
const STEP = 1_024
const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 760, color: 'var(--dsw-alias-label-primary)' },
  header: { display: 'flex', flexDirection: 'column', gap: 5 },
  heading: { margin: 0, fontSize: 18, lineHeight: '24px', fontWeight: 500 },
  subheading: { margin: '0 0 4px', fontSize: 14, lineHeight: '22px', fontWeight: 500 },
  help: { margin: '3px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' },
  rows: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, borderBottom: '0.5px solid var(--dsw-alias-border-l2)', padding: '14px 0' },
  copy: { flex: '2 1 250px', minWidth: 0 },
  label: { display: 'block', fontSize: 14, lineHeight: '22px', fontWeight: 400 },
  control: { display: 'flex', justifyContent: 'flex-end', flex: '1 1 180px', minWidth: 0, gap: 8, alignItems: 'center' },
  number: { width: 110, maxWidth: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  select: { maxWidth: '100%', minHeight: 32, border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)', padding: '5px 8px', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13 },
  budgetControl: { flex: '1 1 250px', display: 'grid', gap: 8, minWidth: 0 },
  value: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, fontSize: 13 },
  slider: { width: '100%', margin: 0, accentColor: 'var(--dsw-alias-state-business-primary)' },
  rangeLabels: { display: 'flex', justifyContent: 'space-between', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' },
  notice: { border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', padding: '12px 14px', background: 'var(--dsw-alias-bg-module-platform)', fontSize: 13, lineHeight: '20px' },
  list: { margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 5, color: 'var(--dsw-alias-label-secondary)' },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, lineHeight: '20px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, lineHeight: '20px', marginTop: 12 },
  cell: { textAlign: 'left', padding: '8px 4px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', fontWeight: 400 },
  loading: { display: 'grid', placeItems: 'center', minHeight: 200 },
} satisfies Record<string, CSSProperties>

/** A Settings row with wrapped controls on narrow screens. */
function Row({ id, title, help, children }: { id: string; title: string; help: string; children: ReactNode }) {
  return <div style={styles.row}>
    <div style={styles.copy}><label htmlFor={id} style={styles.label}>{title}</label><p id={`${id}-help`} style={styles.help}>{help}</p></div>
    <div style={styles.control}>{children}</div>
  </div>
}

function Budget({ id, title, help, value, disabled, t, onChange }: {
  id: string; title: string; help: string; value: string; disabled: boolean;
  t: (key: ContextSettingsLocaleKey) => string; onChange: (value: string) => void;
}) {
  const tokens = Number(value), position = tokens >= MAX_TOKENS ? 147 : Math.round(tokens / STEP)
  return <div style={styles.row}>
    <div style={styles.copy}><label style={styles.label} htmlFor={id}>{title}</label><p style={styles.help} id={`${id}-help`}>{help}</p></div>
    <div style={styles.budgetControl}>
      <div style={styles.value}>
        <Input id={id} type="number" min={0} step={1} value={value} style={styles.number} disabled={disabled}
          aria-describedby={`${id}-help`} onChange={event => onChange(event.currentTarget.value)} />
        <span>{tokens === 0 && value !== '' ? t('unlimited') : t('tokens')}</span>
      </div>
      <input style={styles.slider} type="range" min={0} max={147} step={1} value={Number.isFinite(position) ? position : 0}
        aria-label={title} aria-describedby={`${id}-help`} disabled={disabled}
        aria-valuetext={tokens === 0 ? t('unlimited') : `${value} ${t('tokens')}`}
        onChange={event => { const next = Number(event.currentTarget.value); onChange(String(next >= 147 ? MAX_TOKENS : next * STEP)) }} />
      <div style={styles.rangeLabels} aria-hidden="true"><span>{t('unlimited')}</span><span>150,000</span></div>
      {tokens > MAX_TOKENS ? <p style={styles.help}>{t('aboveRange')}</p> : null}
    </div>
  </div>
}

/** Stage editable controls and commit one atomic, revision-fenced profile update.
 * @param props - Host form, locale and durable notice callback.
 * @returns the plugin's Settings section.
 */
export function ContextSettingsPage({ t, form, notify, loadModels }: ContextSettingsPageProps) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
  const [draft, setDraft] = useState(() => readSettings(snapshot.value))
  const [baseline, setBaseline] = useState(() => readSettings(snapshot.value))
  const [revision, setRevision] = useState(snapshot.revision)
  const [saving, setSaving] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogRevision, setCatalogRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setCatalogLoading(true); setCatalogFailed(false)
    void loadModels().then(value => { if (alive) setCatalog(value) }, () => { if (alive) setCatalogFailed(true) })
      .finally(() => { if (alive) setCatalogLoading(false) })
    return () => { alive = false }
  }, [loadModels, catalogRevision])
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  useEffect(() => {
    if (dirty || snapshot.status !== 'ready') return
    const current = readSettings(snapshot.value)
    setDraft(current); setBaseline(current); setRevision(snapshot.revision)
  }, [dirty, snapshot])
  if (snapshot.status === 'unavailable') return <p style={styles.help} role="status">{t('unavailable')}</p>
  if (snapshot.status !== 'ready' || snapshot.value === undefined) return <div style={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={24} /></div>
  const stale = dirty && snapshot.revision !== revision
  const disabled = !snapshot.writable || saving
  const error = settingsError(draft) ?? modelSettingsError(draft, baseline, catalog)
  const edit = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]): void => { setDraft(previous => ({ ...previous, [key]: value })) }
  const reload = (): void => {
    const current = readSettings(form.getSnapshot().value)
    setDraft(current); setBaseline(current); setRevision(form.getSnapshot().revision)
  }
  const save = async (): Promise<void> => {
    if (!dirty || stale || error !== undefined || disabled || revision === undefined) return
    setSaving(true)
    try {
      if (await saveSettings(form, draft, baseline, revision)) {
        // Only the accepted Host snapshot becomes the next edit baseline.
        reload(); notify('saved')
      } else notify('saveFailed')
    } catch (error) {
      // The shared notice reports transport refusal while the staged inputs remain visible.
      notify('saveFailed')
    } finally { setSaving(false) }
  }
  const numberRow = (key: 'maxWorkers' | 'maxConcurrentAgents' | 'maxActiveGenerations' | 'maxChildStarts' | 'maxAttemptsPerTask', min: number, max?: number) => {
    const id = `task-orchestrator-${key}`
    return <Row id={id} title={t(`${key}Title`)} help={t(`${key}Help`)}>
      <Input id={id} type="number" min={min} max={max} step={1} value={draft[key]} style={styles.number} disabled={disabled}
        aria-describedby={`${id}-help`} onChange={event => edit(key, event.currentTarget.value)} />
    </Row>
  }
  return <section style={styles.page}>
    <header style={styles.header}><h2 style={styles.heading}>{t('title')}</h2><p style={styles.help}>{t('summary')}</p></header>
    {!snapshot.writable ? <p role="status" style={styles.help}>{t('readOnly')}</p> : null}
    <aside style={styles.notice}>
      <h3 style={styles.subheading}>{t('howTitle')}</h3><p style={styles.help}>{t('howSummary')}</p>
    </aside>
    <div>
      <div style={styles.actions}><h3 style={styles.subheading}>{t('modelsTitle')}</h3>
        <Button variant="outline" size="sm" disabled={catalogLoading} onClick={() => setCatalogRevision(value => value + 1)}>{t('refreshModels')}</Button>
      </div>
      <p style={styles.help}>{t('modelsHelp')}</p>
      {catalogFailed ? <p role="status" style={styles.error}>{t('modelsFailed')}</p> : null}
      {catalog?.failures.length ? <p role="status" style={styles.help}>{t('modelsPartial')} {catalog.failures.map(provider => provider.name).join(', ')}</p> : null}
      <div style={styles.rows}>{MODEL_ROLES.map(fields => {
        const provider = draft[fields.provider], modelId = draft[fields.model], effort = draft[fields.effort]
        const selected = modelId ? JSON.stringify([provider, modelId]) : ''
        const model = catalog?.groups.find(group => group.id === provider)?.models.find(model => model.id === modelId)
        const efforts = model?.reasoning?.efforts ?? []
        const id = `task-orchestrator-${fields.role}-model`, effortId = `${id}-effort`
        return <div key={fields.role}>
          <Row id={id} title={t(`${fields.role}Model`)} help={t(`${fields.role}ModelHelp`)}>
            <select id={id} style={{ ...styles.select, width: '100%' }} value={selected} disabled={disabled || (!catalog && catalogLoading)} aria-describedby={`${id}-help`}
              onChange={event => {
                const chosen = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
                  .find(model => JSON.stringify([model.provider, model.model]) === event.currentTarget.value)
                setDraft(previous => ({ ...previous, [fields.provider]: chosen?.provider ?? '', [fields.model]: chosen?.model ?? '', [fields.effort]: '' }))
              }}>
              <option value="">{t(`${fields.role}Inherit`)}</option>
              {selected && model === undefined ? <option value={selected}>{provider ? `${provider} / ` : ''}{modelId} ({t(!provider && fields.role === 'worker' ? 'legacyModel' : 'modelUnavailable')})</option> : null}
              {catalog?.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model =>
                <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>)}</optgroup>)}
            </select>
          </Row>
          <Row id={effortId} title={t(`${fields.role}Effort`)} help={t('effortHelp')}>
            <select id={effortId} style={{ ...styles.select, width: '100%' }} value={effort} disabled={disabled || efforts.length === 0} aria-describedby={`${effortId}-help`}
              onChange={event => edit(fields.effort, event.currentTarget.value)}>
              <option value="">{t(modelId ? 'effortDefault' : 'effortInherit')}</option>
              {effort && !efforts.some(value => value.id === effort) ? <option value={effort}>{effort} ({t('modelUnavailable')})</option> : null}
              {efforts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
            </select>
          </Row>
        </div>
      })}</div>
    </div>
    <div>
      <h3 style={styles.subheading}>{t('executionTitle')}</h3>
      <div style={styles.rows}>
        <Row id="task-orchestrator-mode" title={t('modeTitle')} help={t('modeHelp')}>
          <select id="task-orchestrator-mode" style={styles.select} value={draft.mode} disabled={disabled} aria-describedby="task-orchestrator-mode-help"
            onChange={event => edit('mode', event.currentTarget.value as SettingsDraft['mode'])}>
            <option value="hybrid">{t('modeHybrid')}</option><option value="suggest">{t('modeSuggest')}</option>
            {draft.mode === 'auto' ? <option value="auto">{t('modeAuto')}</option> : null}<option value="off">{t('modeOff')}</option>
          </select>
        </Row>
        {numberRow('maxConcurrentAgents', 2, 6)}
        {numberRow('maxWorkers', draft.requireReview ? 3 : 2, 6)}
        <Row id="task-orchestrator-review" title={t('reviewTitle')} help={t('reviewHelp')}>
          <Switch checked={draft.requireReview} disabled={disabled} label={t('reviewTitle')} onChange={value => edit('requireReview', value)} />
        </Row>
        {numberRow('maxActiveGenerations', 1)}
      </div>
    </div>
    <div>
      <h3 style={styles.subheading}>{t('contextTitle')}</h3>
      <div style={styles.rows}>
        <Budget id="task-orchestrator-hard-context" title={t('singleTitle')} help={t('singleHelp')} value={draft.hardContextTokens} disabled={disabled} t={t} onChange={value => edit('hardContextTokens', value)} />
        <Budget id="task-orchestrator-total-context" title={t('totalTitle')} help={t('totalHelp')} value={draft.totalContextTokens} disabled={disabled} t={t} onChange={value => edit('totalContextTokens', value)} />
      </div>
      <p style={styles.help}>{t('rounding')}</p>
    </div>
    <details style={styles.notice}>
      <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{t('advanced')}</summary>
      <p style={styles.help}>{t('tiersHelp')}</p>
      <table style={styles.table}>
        <thead><tr><th style={styles.cell}>{t('tierContext')}</th><th style={styles.cell}>{t('tierStreams')}</th></tr></thead>
        <tbody>{draft.concurrencyByContext.map((tier, index) => <tr key={index}>
          <td style={styles.cell}><Input type="number" min={1} step={1} value={tier.maxContextTokens} disabled={disabled}
            aria-label={`${t('tierContext')} ${index + 1}`} style={styles.number}
            onChange={event => edit('concurrencyByContext', draft.concurrencyByContext.map((current, row) => row === index ? { ...current, maxContextTokens: Number(event.currentTarget.value) } : current))} /></td>
          <td style={styles.cell}><Input type="number" min={1} step={1} value={tier.maxActiveGenerations} disabled={disabled}
            aria-label={`${t('tierStreams')} ${index + 1}`} style={styles.number}
            onChange={event => edit('concurrencyByContext', draft.concurrencyByContext.map((current, row) => row === index ? { ...current, maxActiveGenerations: Number(event.currentTarget.value) } : current))} /></td>
        </tr>)}</tbody>
      </table>
      {numberRow('maxChildStarts', 1, 48)}{numberRow('maxAttemptsPerTask', 1, 8)}
      <p style={styles.help}>{t('advancedHelp')}</p>
    </details>
    <aside style={styles.notice}><ul style={styles.list}>
      <li>{t('requestRule')}</li><li>{t('sharedRule')}</li><li>{t('zeroRule')}</li><li>{t('applyRule')}</li>
    </ul></aside>
    {dirty && error !== undefined ? <p style={styles.error} role="alert">{t(error)}</p> : null}
    {stale ? <div style={styles.actions} role="status"><p style={styles.error}>{t('conflict')}</p><Button variant="outline" size="sm" onClick={reload}>{t('reload')}</Button></div> : null}
    <div style={styles.actions}>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setDraft(previous => {
        const defaults = readSettings(undefined)
        for (const fields of MODEL_ROLES) for (const key of [fields.provider, fields.model, fields.effort]) defaults[key] = previous[key]
        return defaults
      })}>{t('defaults')}</Button>
      <Button variant="primary" disabled={!dirty || stale || error !== undefined || disabled || revision === undefined} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button>
    </div>
  </section>
}
