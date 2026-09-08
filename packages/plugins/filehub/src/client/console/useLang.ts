/**
 * React binding for the i18n language signal. Lives under console/ because
 * that is this milestone's home turf; the settings panel imports it too (both
 * folders belong to M5). Uses useSyncExternalStore so a host locale switch
 * re-renders every consumer exactly once.
 */
import { useSyncExternalStore } from 'react'

import { getI18nLang, subscribeI18n } from '../i18n.js'
import type { Lang } from '../util.js'

/** Current UI language as reactive state. */
export function useI18nLang(): Lang {
  return useSyncExternalStore(subscribeI18n, getI18nLang)
}
