/**
 * The parent-environment scrub: which ambient names a child keeps.
 *
 * The harness home family decides which distribution a child belongs to, so
 * scrubbing it sends a nested `dsh` command to the official default home and
 * the official harness, zDSH and zDSH-Go install into and read from one
 * another. This spec lives beside a consumer of {@link scrubbedParentEnv}
 * because the subprocess package's own tests are excluded from the default
 * gate.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

describe('scrubbedParentEnv', () => {
  it('keeps the distribution home family and scrubs every other DSH_ name', () => {
    vi.stubEnv('DSH_HOME', 'D:\\dist\\data')
    vi.stubEnv('DSH_BRANCH_HOME', 'D:\\dist\\data\\zdsh')
    vi.stubEnv('DSH_AGENTS_HOME', 'D:\\dist\\data\\agents')
    vi.stubEnv('DSH_SESSION_ID', 'session-should-not-leak')
    vi.stubEnv('DSH_PROFILE', 'web-should-not-leak')
    onTestFinished(() => { vi.unstubAllEnvs() })

    const env = scrubbedParentEnv()

    expect(env.DSH_HOME).toBe('D:\\dist\\data')
    expect(env.DSH_BRANCH_HOME).toBe('D:\\dist\\data\\zdsh')
    expect(env.DSH_AGENTS_HOME).toBe('D:\\dist\\data\\agents')
    expect(env.DSH_SESSION_ID).toBeUndefined()
    expect(env.DSH_PROFILE).toBeUndefined()
  })

  it('still scrubs secrets', () => {
    vi.stubEnv('SOME_API_KEY', 'sk-should-not-leak')
    onTestFinished(() => { vi.unstubAllEnvs() })

    expect(scrubbedParentEnv().SOME_API_KEY).toBeUndefined()
  })
})
