/**
 * Preserve electron-notarize's signature checks and stapling while recording separate Apple phases.
 * Pinned to the 3.x line: its notarytool-only notarize() keeps the `notarytoolPath` seam and the
 * `submit … --wait --output-format json` / `log <id>` argv contract that logged-notarytool.mjs adapts,
 * and keeps this wrapper's error text unchanged (only the 2.x altool entry points were dropped).
 */
import { fileURLToPath } from 'node:url'
import { notarize } from '@electron/notarize'
import { packagingStep } from './packaging-step.mjs'

/**
 * Notarize and staple one App or DMG through the measured notarytool adapter.
 * @param {object} options Validated credentials and appPath accepted by electron-notarize.
 * @returns {Promise<void>} Resolves only after Apple acceptance and stapling.
 */
export async function notarizeMacOS(options) {
  const secrets = Object.entries(options).filter(([name]) => /password|key|appleId/iu.test(name)).map(([, value]) => String(value))
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'notarize-and-staple',
    () => notarize({ ...options, notarytoolPath: fileURLToPath(new URL('./logged-notarytool.mjs', import.meta.url)) }), secrets)
}
