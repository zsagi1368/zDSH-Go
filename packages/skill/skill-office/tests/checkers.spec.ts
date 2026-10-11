import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// zDSH (SYNC-P1-FIX, 2026-09-29): 30s case budget (A3/PDF-FLAKE overlay precedent; source:
// sync-017 D4-9 item 2 / D4-4 budget family). Each case spawns a real python child
// (check_office_test.py); under full-run parallel load the 5s default starved — D4 full
// run 2F at the 5s timeout, isolated reruns green at 5.94/5.93s. The 30s matches the
// existing spawnSync child budget below. Budget widening only — the expect bodies are
// unchanged, so a real checker regression still fails on content regardless of timing.
it.each(['utf-8', 'cp1252'])('executes the shipped OOXML checker against valid, edited, and broken documents with %s stdout', { timeout: 30_000 }, (encoding) => {
  const python = process.env.DSH_OFFICE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [fileURLToPath(new URL('./check_office_test.py', import.meta.url))], {
    env: { ...process.env, PYTHONIOENCODING: encoding },
    encoding: 'utf8', timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr + result.stdout).toBeNull()
  expect(result.status, result.stderr + result.stdout).toBe(0)
})
