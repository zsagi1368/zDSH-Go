/**
 * Slot vocabulary shared by the registry runtime and the durable-audit
 * invariant companion, so both faces validate against one closed set without
 * importing the service runtime.
 *
 * @module @deepseek-ai/dsh-model-slots/vocabulary
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one auxiliary-model slot. */
export type SlotId = Branded<'SlotId'>

/**
 * Brand one implementation-owned slot identity.
 * @param id - opaque slot identity used in configuration and audit records.
 * @returns the same string, branded; no validation is performed.
 */
export function SlotId(id: string): SlotId {
  return id as SlotId
}

/** Built-in slot: conversation-title generation. */
export const MODEL_SLOT_TITLE = SlotId('title')

/** Built-in slot: context-compaction summarization. */
export const MODEL_SLOT_COMPACTION_SUMMARIZE = SlotId('compaction.summarize')

/** Built-in slot: visual-assist digestion of image inputs for text-only routes. */
export const MODEL_SLOT_VISION = SlotId('vision')

/** Built-in slot: plan-mode plan drafting on a stronger model while execution keeps the main model. */
export const MODEL_SLOT_PLAN = SlotId('plan')

/** Closed built-in slot vocabulary that configuration and audit records accept. */
export const MODEL_SLOT_IDS: ReadonlySet<string> = new Set([
  MODEL_SLOT_TITLE,
  MODEL_SLOT_COMPACTION_SUMMARIZE,
  MODEL_SLOT_VISION,
  MODEL_SLOT_PLAN,
])

/** Every origin tier a resolved auxiliary route can carry. */
export const MODEL_SLOT_SOURCES: ReadonlySet<string> = new Set([
  'slot',
  'deployment-default',
  'main-route',
])
