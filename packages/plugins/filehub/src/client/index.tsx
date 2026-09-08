/**
 * Client half entry, served as /plugins/filehub/client.js and loaded through
 * the ModuleLoader factory handshake (banner/footer in build.mjs).
 *
 * M1 upload domain (P01 §6-A): the composer tool-row upload entry (button +
 * page-wide drag mask + paste) in `conversation.input.left`, and the queue
 * dock in `conversation.input.dock`. Both share one module-level UploadQueue —
 * "三处入口一个队列" (P01 §8 UX-1).
 *
 * Slot facts verified against the host d.ts (integration evidence):
 * - runtime lib/types/client/index.d.ts merges SessionStandardProps:
 *   every session-scope slot component receives `sessionId` plus useSession;
 *   ui-conversation adds `useInput`/`inputActions`.
 * - ui-conversation src/client/contract/slots.ts declares both targets as
 *   `{ kind: 'list'; scope: 'session'; owner: InputZone }`, so registration
 *   uses a list `id` (+ display order) and components may ignore the owner
 *   share entirely.
 * - runtime lib/types/client/slots.d.ts: ctx.slots.inject(key, callback)
 *   waits for the declaration, runs the callback's registrations under the
 *   caller's fiber, and disposes them when the declaration collapses.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-renderer Context merge (ctx.slots registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-conversation SlotMap merge (conversation.input.*,
// conversation.view).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-settings SlotMap merge (settings.plugins.tab).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

// M2 mention pipeline (P01 §6-B): @ trigger source + chip reference bar.
import { FileHubChips } from './mention/chips.js'
import { registerMentionTrigger } from './mention/source.js'
import { FileHubDock } from './upload/dock.js'
import { resolveSessionId, UploadEntries } from './upload/entries.js'
import { UploadQueue } from './upload/queue.js'
// M5 console + settings + i18n (P01 §6-E / §7).
import { FileConsoleView } from './console/FileConsoleView.js'
import { FileHubSettingsPanel } from './settings/FileHubSettingsPanel.js'
import { bindHostLocale, t } from './i18n.js'

/** Client bundles this plugin requires the host to provide first. */
const inject = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
]

/** Registrant inject face shared by both slot entries. */
interface FileHubInjectFace {
  readonly queue: UploadQueue
}

let queueSingleton: UploadQueue | undefined

function getQueue(): UploadQueue {
  if (queueSingleton === undefined) {
    queueSingleton = new UploadQueue({
      // Consulted per dispatch; null fails items loud as 'sessionMissing'.
      sessionId: () => resolveSessionId(),
    })
  }
  return queueSingleton
}

function apply(ctx: ClientContext): void {
  ctx.logger.info('[filehub] client M1 upload domain loaded')

  // M5 language signal: follow the host locale when the composition ships
  // dsh-client-locale (guarded structural probe — a bare context keeps the
  // navigator-derived default; see src/client/i18n.ts header for evidence).
  bindHostLocale(
    (ctx as { locale?: Parameters<typeof bindHostLocale>[0] }).locale,
  )

  // GLOBAL DISABLE COORDINATION (P01 §7, FR-E5): settings.enabled=false is the
  // single master switch. Degradation ownership per face:
  // - console view: FileConsoleView gates on GET /api/filehub/settings and
  //   renders nothing when disabled;
  // - this tab registration itself stays live so users can re-enable;
  // - upload entries/dock + mention trigger/chips degrade on their own terms
  //   in their modules (M1/M2 behavior, unchanged here).

  const queue = getQueue()

  // Composer tool-row: upload button + drag mask + paste listener.
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'zdsh-filehub-upload-entry',
        order: 40,
        registrant: 'zdsh-filehub',
        inject: (): FileHubInjectFace => ({ queue }),
      },
      UploadEntries,
    ),
  )

  // Under-the-card queue strip.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'zdsh-filehub-dock',
        order: 20,
        registrant: 'zdsh-filehub',
        inject: (): FileHubInjectFace => ({ queue }),
      },
      FileHubDock,
    ),
  )

  // ---- M2 mention pipeline (P01 §6-B) --------------------------------------
  // `@` trigger source: candidates from /api/filehub/search (debounced),
  // picks insert a plain-text @token aligned with the host grammar. Skips
  // registration entirely when the feature toggle is off or the
  // inputTriggers service is absent — degrade, never throw.
  registerMentionTrigger(ctx, { sessionId: () => resolveSessionId() })

  // Chip reference bar: second entry in the SAME dock slot (the slot is
  // declared kind:'list', so multiple injectors are allowed). Chips parse the
  // live draft's @tokens via the framework useInput standard kit.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'zdsh-filehub-mention-chips',
        order: 21,
        registrant: 'zdsh-filehub',
        inject: (): FileHubInjectFace => ({ queue }),
      },
      FileHubChips,
    ),
  )

  // ---- M5 file console tab (P01 §6-E FR-E1/E2/E3) ---------------------------
  // A 'Files' tab in the conversation view ring. Label is a thunk over the
  // i18n dictionary so it follows host locale switches without re-registration.
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'zdsh-filehub-files',
        order: 30,
        registrant: 'zdsh-filehub',
        label: () => t('console.tab'),
      },
      FileConsoleView,
    ),
  )

  // ---- M5 settings center tab (P01 §7 FR-E5') -------------------------------
  // One page inside the host's Plugins settings section. Standalone-plugin
  // transport: the panel reads/writes FileHub's own GET/PUT settings endpoints
  // (see src/client/settings/FileHubSettingsPanel.tsx header).
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'zdsh-filehub',
        order: 60,
        registrant: 'zdsh-filehub',
        label: () => t('settings.tab'),
      },
      FileHubSettingsPanel,
    ),
  )
}

// The ModuleLoader factory wraps this file in `var module = { exports: {} }`,
// so a plain CJS assignment is the handoff contract.
declare const module: { exports: Record<string, unknown> }
module.exports = { apply, inject }
