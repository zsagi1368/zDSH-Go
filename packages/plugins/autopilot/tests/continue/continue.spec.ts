import { describe, expect, it } from 'vitest'
import {
  detectBootScan,
  detectLive,
} from '../../src/continue/detector.js'
import {
  buildResumeText,
  fillTemplate,
  formatElapsed,
} from '../../src/continue/resumetext.js'

describe('interruption detector', () => {
  const opts = { classifyErrors: true }

  it('never resumes user stops, policy blocks, or completed turns', () => {
    for (const reason of ['aborted', 'blocked', 'completed'] as const) {
      expect(detectLive(reason, undefined, opts).action).toBe('skip')
    }
  })

  it('resumes max-tokens with the dedicated template routing', () => {
    expect(detectLive('max-tokens', undefined, opts)).toEqual({ action: 'schedule-resume' })
  })

  it.each([
    ['auth-status', { status: 401 }],
    ['auth-status', { status: 403 }],
    ['auth', { message: 'invalid api key provided' }],
    ['quota', { message: 'insufficient balance for account' }],
    ['model', { message: 'unknown model: x-99' }],
    ['context-overflow', { code: 'ctx_len_err', message: 'maximum context length exceeded' }],
    ['invalid-request', { code: 'bad_request' }],
  ])('classifies %s failures as permanent skips', (_family, failure) => {
    const outcome = detectLive('error', failure, opts)
    expect(outcome.action).toBe('skip')
    expect(outcome.skipReason).toBe('permanent-failure')
  })

  it.each([
    ['network text', { message: 'network connection reset' }],
    ['timeout text', { message: 'request timeout after 30s' }],
    ['econn family', { code: 'ECONNRESET' }],
    ['5xx-ish upstream', { message: 'upstream unavailable (502)' }],
  ])('treats transient signals as resume-worthy: %s', (_label, failure) => {
    expect(detectLive('error', failure, opts).action).toBe('schedule-resume')
  })

  it('unknown errors default to transient (a lost turn costs more than a prompt)', () => {
    expect(detectLive('error', { message: 'something odd happened' }, opts).action).toBe(
      'schedule-resume',
    )
  })

  it('classifyErrors=false resumes every error blindly', () => {
    expect(
      detectLive('error', { status: 403 }, { classifyErrors: false }).action,
    ).toBe('schedule-resume')
  })

  it('boot scan claims interrupted turns; live path never sees them', () => {
    expect(detectBootScan('interrupted', undefined, opts).action).toBe('schedule-resume')
  })
})

describe('resume text builder', () => {
  it('fills placeholders and formats elapsed time like a human clock', () => {
    expect(formatElapsed(65_000)).toBe('1m5s')
    expect(formatElapsed(9_400)).toBe('9s')
    expect(fillTemplate('retry {code} after {elapsed}', { code: 'E42', elapsedMs: 65_000 })).toBe(
      'retry E42 after 1m5s',
    )
  })

  it('appends the pending-tool guardrail and names the tool', () => {
    const text = buildResumeText({
      kind: 'continue',
      texts: { continue: 'Continue', continueMaxTokens: 'Continue', loop: 'L' },
      ctx: { tool: 'bash' },
      guardState: 'pending',
      guards: { pending: '{tool} may be unfinished — verify first.' },
    })
    expect(text).toContain('Continue\n\nbash may be unfinished')
  })

  it('adds the done-guardrail but no guardrail for failed tools', () => {
    const base = { kind: 'continue' as const, texts: { continue: 'Go on', continueMaxTokens: 'x', loop: 'l' }, ctx: {} }
    const done = buildResumeText({ ...base, guardState: 'done', guards: { done: 'already completed — do not redo.' } })
    expect(done).toContain('do not redo')
    const failed = buildResumeText({ ...base, guardState: 'failed', guards: { done: 'nope' } })
    expect(failed).toBe('Go on')
  })

  it('loop restarts use the loop text without tool guardrails', () => {
    const text = buildResumeText({
      kind: 'loop',
      texts: { continue: 'c', continueMaxTokens: 'c', loop: 'Stuck ({tool})?' },
      ctx: {},
      guardState: 'pending',
      guards: { pending: 'guard' },
    })
    expect(text).toBe('Stuck ()?')
  })
})
