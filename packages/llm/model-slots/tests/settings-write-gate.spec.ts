/**
 * Write-door lock for the closed slot vocabulary.
 *
 * The registry already refuses an unknown slot id at construction, but that
 * rejection lands *after* the profile file was written: the entry then fails to
 * mount on the next boot, `ctx.get('modelSlots')` is undefined, and the Models
 * page cannot repair it because `SettingsForms.describe()` returns only ACTIVE
 * entries. This suite drives the real settings write path over a real profile
 * directory to prove the schema refuses such a key before `configEditor.edit`
 * persists anything, and that a built-in key still writes.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import ModelSlotRegistry, { MODEL_SLOT_VISION } from '../src/index.ts'

/** The write path validated here is the one the Models page's slot editor drives. */
it('refuses an unknown slot id before the profile file is written and accepts a built-in one', async () => {
  // The fixture mounts its probe row with this Config, so the entry's own
  // schema — the one `configEditor.edit` resolves before persisting — is the
  // real model-slots schema.
  const { ctx, profile } = await configurationFixture({ schema: ModelSlotRegistry.Config })
  const before = readFileSync(profile.patchPath, 'utf8')

  await expect(ctx.settings.mutate('first', [{
    op: 'set', path: ['slots', 'nope'], value: { provider: 'stray-provider', model: 'stray-model' },
  }])).rejects.toThrow(/"nope"/)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)

  await ctx.settings.mutate('first', [{
    op: 'set', path: ['slots', MODEL_SLOT_VISION], value: { provider: 'vision-provider', model: 'vision-model' },
  }])
  const written = readFileSync(profile.patchPath, 'utf8')
  expect(written).toContain(MODEL_SLOT_VISION)
  expect(written).toContain('vision-provider')
})
