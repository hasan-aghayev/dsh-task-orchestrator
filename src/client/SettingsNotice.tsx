/** Settings outcomes hosted in the shell so closing the page keeps its notice visible. @module */
import { useSyncExternalStore } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** One accepted or refused settings update. */
interface Notice { kind: 'saved' | 'saveFailed'; sequence: number }

/** Per-plugin notice store shared by the page and the shell overlay. */
export class SettingsNotices {
  private value: Notice | null = null
  private sequence = 0
  private readonly listeners = new Set<() => void>()
  /** @returns current notice, stable until publish or dismiss. */
  getSnapshot = (): Notice | null => this.value
  /** Observe notice replacements.
   * @param listener - callback invoked after a replacement.
   * @returns observer disposer.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Publish an outcome outside the Settings page lifetime.
   * @param kind - accepted or refused update.
   */
  publish = (kind: Notice['kind']): void => { this.value = { kind, sequence: ++this.sequence }; this.listeners.forEach(listener => listener()) }
  /** Clear the current notice after the shared Toast fades. */
  dismiss = (): void => { this.value = null; this.listeners.forEach(listener => listener()) }
}

/** Overlay injection supplied when the plugin registers its client half. */
export interface SettingsNoticeInjected { notices: SettingsNotices }

/** Render the shared Toast for profile writes.
 * @param props - notice store and localized Settings copy.
 * @returns a transient notice, or null.
 */
export function SettingsNotice({ notices, t }: PropsLocale<'settings.task-orchestrator'> & InjectFace<SettingsNoticeInjected>) {
  const notice = useSyncExternalStore(notices.subscribe, notices.getSnapshot, notices.getSnapshot)
  return notice === null ? null : <Toast key={notice.sequence} text={t(notice.kind)} tone={notice.kind === 'saved' ? 'success' : undefined} onDone={notices.dismiss} />
}
