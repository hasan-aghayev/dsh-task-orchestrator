/** Client-side settings page for Task Orchestrator. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ContextSettingsPage } from './ContextSettingsPage.js'
import type { ContextSettingsInjected, TaskOrchestratorSettings } from './ContextSettingsPage.js'
import { en, zh, type ContextSettingsLocaleKey } from './locales.js'
import { SettingsNotice, SettingsNotices } from './SettingsNotice.js'

/** Dictionary namespace registered for the plugin's page. */
export const NS = 'settings.task-orchestrator'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task Orchestrator Settings section copy. */
    'settings.task-orchestrator': ContextSettingsLocaleKey
  }
}

/** Client services required by the Settings section and its form. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the Settings navigation entry while this plugin is enabled.
 * @param ctx - The browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<TaskOrchestratorSettings>('task-orchestrator')
  const notices = new SettingsNotices()
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'task-orchestrator settings dictionaries')
  const injected = (): ContextSettingsInjected => ({ form, notify: notices.publish })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'task-orchestrator',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ContextSettingsPage)), 'task-orchestrator Settings section')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'task-orchestrator.settings-notice', locale: NS,
    inject: () => ({ notices }),
  }, SettingsNotice)), 'task-orchestrator settings outcomes')
}
