import { describe, expect, it } from 'vitest'
import {
  isCredentialTree,
  isCriticalPath,
  isProtectedProjectMeta,
  isWithin,
  normalizePath,
} from '../../src/guard/pathhard.js'
import { SessionArtifacts } from '../../src/guard/artifacts.js'
import type { FsProbePort } from '../../src/guard/artifacts.js'
import { decomposeBash, decomposePwsh } from '../../src/guard/shelllex/lexer.js'
import { assessCommandLine, opaqueAssessment } from '../../src/guard/shelllex/assess.js'
import { assessTool, hardDeny } from '../../src/guard/policy.js'
import { FailureLadder, buildClassifierInput, parseClassifierOutput } from '../../src/guard/classify.js'
import { EscalationGrants } from '../../src/guard/escalate.js'
import { createGuardModule } from '../../src/guard/index.js'
import type { GuardAdapters } from '../../src/guard/index.js'
import { createKernel } from '../../src/kernel/facade.js'

const ROOTS = {
  workspaceRoot: 'G:\\work\\proj',
  homePath: 'C:\\Users\\dev',
  dshHomePath: 'C:\\Users\\dev\\.dsh-zdsh',
}

describe('path hardening', () => {
  it('folds casing, trailing dots and NT prefixes for comparison', () => {
    const n = normalizePath('\\\\?\\G:\\Work\\Proj\\A.TXT. .')
    expect(n.normalized.toLowerCase()).toBe('g:\\work\\proj\\a.txt')
    expect(n.isAbsolute).toBe(true)
  })

  it('flags reserved device names', () => {
    expect(normalizePath('CON').reservedDeviceName).toBe(true)
    expect(normalizePath('G:\\x\\COM1').reservedDeviceName).toBe(false) // only first segment judged
    expect(normalizePath('COM1').reservedDeviceName).toBe(true)
  })

  it('detects drive-relative ambiguity (C:.. style)', () => {
    expect(normalizePath('C:..\\..\\x').driveRelativeAmbiguity).toBe(true)
    expect(normalizePath('C:\\x').driveRelativeAmbiguity).toBe(false)
  })

  it('containment survives cross-drive relative() returning absolute paths', () => {
    expect(isWithin('G:\\work', 'G:\\work\\proj\\a')).toBe(true)
    // Different drive: relative() yields an absolute path — must NOT pass.
    expect(isWithin('G:\\work', 'C:\\Users\\dev\\.ssh')).toBe(false)
  })

  it('marks critical paths', () => {
    expect(isCriticalPath(ROOTS, 'G:\\')).toBe(true)
    expect(isCriticalPath(ROOTS, 'C:\\Users\\dev')).toBe(true)
    expect(isCriticalPath(ROOTS, 'C:\\Windows\\System32\\config')).toBe(true)
    expect(isCriticalPath(ROOTS, '/etc/passwd'.replace(/\//g, '\\'))).toBe(true)
    expect(isCriticalPath(ROOTS, 'G:\\work\\proj\\src')).toBe(false)
  })

  it('recognizes credential trees anywhere in the path', () => {
    expect(isCredentialTree('C:\\Users\\dev\\.ssh')).toBe(true)
    expect(isCredentialTree('G:\\work\\.aws\\credentials'.replace(/\//g, '\\'))).toBe(true)
    expect(isCredentialTree('G:\\work\\src')).toBe(false)
  })

  it('protects project metadata inside the workspace only', () => {
    expect(isProtectedProjectMeta(ROOTS.workspaceRoot, 'G:\\work\\proj\\.git\\config')).toBe(true)
    expect(isProtectedProjectMeta(ROOTS.workspaceRoot, 'G:\\work\\proj\\.mcp.json')).toBe(true)
    expect(isProtectedProjectMeta(ROOTS.workspaceRoot, 'G:\\work\\proj\\src\\main.ts')).toBe(false)
  })
})

// ---------------------------------------------------------------------------

function makeFs(): FsProbePort & { files: Map<string, { dev: number; ino: number; birthtimeMs: number; isDirectory: boolean }> } {
  const files = new Map<string, { dev: number; ino: number; birthtimeMs: number; isDirectory: boolean }>()
  const norm = (p: string) => p.replace(/\/+/g, '\\').toLowerCase()
  return {
    files,
    lstat(path) {
      return files.get(norm(path))
    },
    listDir(dir) {
      const prefix = `${norm(dir)}\\`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length)
          names.add(rest.split('\\')[0] ?? rest)
        }
      }
      return [...names]
    },
    join(...parts) {
      return parts.join('\\')
    },
  }
}

describe('session artifacts (identity as the authorization carrier)', () => {
  function world() {
    const fs = makeFs()
    fs.files.set('g:\\work\\proj', { dev: 1, ino: 1, birthtimeMs: 1000, isDirectory: true })
    const artifacts = new SessionArtifacts(fs, 'G:\\work\\proj', 50_000)
    return { fs, artifacts }
  }

  it('planned creates settle only when previously absent and successful', () => {
    const { fs, artifacts } = world()
    artifacts.planCreate('G:\\work\\proj\\out.txt')
    fs.files.set('g:\\work\\proj\\out.txt', { dev: 1, ino: 2, birthtimeMs: 2000, isDirectory: false })
    expect(artifacts.settleCreate('G:\\work\\proj\\out.txt', true, true)).toBe(false) // existed before
    expect(artifacts.settleCreate('G:\\work\\proj\\out.txt', false, false)).toBe(false) // call failed
    expect(artifacts.settleCreate('G:\\work\\proj\\out.txt', false, true)).toBe(true)
    expect(artifacts.has('G:\\work\\proj\\out.txt')).toBe(true)
  })

  it('rename/replace steals identity and revokes eligibility', () => {
    const { fs, artifacts } = world()
    artifacts.planCreate('G:\\work\\proj\\tmp.log')
    fs.files.set('g:\\work\\proj\\tmp.log', { dev: 1, ino: 3, birthtimeMs: 3000, isDirectory: false })
    artifacts.settleCreate('G:\\work\\proj\\tmp.log', false, true)

    fs.files.set('g:\\work\\proj\\tmp.log', { dev: 1, ino: 99, birthtimeMs: 4000, isDirectory: false })
    expect(artifacts.has('G:\\work\\proj\\tmp.log')).toBe(false) // recreated file ≠ session artifact
  })

  it('snapshot diff attributes only genuinely-new births; old inodes moving into new dirs fail', () => {
    const { fs, artifacts } = world()
    const before = new Map(artifacts.snapshot() ?? [])
    fs.files.set('g:\\work\\proj\\new.bin', { dev: 1, ino: 10, birthtimeMs: 5000, isDirectory: false })
    fs.files.set('g:\\work\\proj\\moved.bin', { dev: 1, ino: 11, birthtimeMs: 500, isDirectory: false })
    const after = artifacts.snapshot() ?? new Map()
    const created = artifacts.diffSnapshots(before, after, 4900)
    expect(created.map(c => c.endsWith('new.bin'))).toContain(true)
    expect(created.some(c => c.endsWith('moved.bin'))).toBe(false) // old birth fails the gate
  })
})

describe('shell lexing + assessment', () => {
  it('splits bash compound commands on joiners respecting quotes', () => {
    const d = decomposeBash('echo "a && b" && rm build.log | tee x')
    expect(d.segments.map(s => s.joiner)).toEqual([undefined, '&&', '|'])
    expect(d.segments.map(s => s.text)).toEqual(['echo "a && b"', 'rm build.log', 'tee x'])
  })

  it('marks substitution/heredoc lines opaque instead of guessing', () => {
    expect(decomposeBash('grep $(cat list) file').segments[0]?.kind).toBe('opaque')
    const pwsh = decomposePwsh('Get-Content @params')
    expect(pwsh.segments[0]?.kind).toBe('opaque')
    expect(decomposeBash('echo "unbalanced').opaqueReason).toBe('unbalanced-quote')
  })

  it('deletion five tiers: session artifact allowed; pre-existing classified; multi-target denied', () => {
    const { fs, artifacts } = world2()
    artifacts.planCreate('G:\\work\\proj\\gen.txt')
    fs.files.set('g:\\work\\proj\\gen.txt', { dev: 1, ino: 20, birthtimeMs: 6000, isDirectory: false })
    artifacts.settleCreate('G:\\work\\proj\\gen.txt', false, true)

    const allow = assessCommandLine('bash', 'rm gen.txt', artifacts, ROOTS)
    expect(allow.decision).toBe('allow')

    const classify = assessCommandLine('bash', 'rm src\\main.ts', artifacts, ROOTS)
    expect(classify.decision).toBe('classify')

    const multi = assessCommandLine('bash', 'rm a.txt b.txt', artifacts, ROOTS)
    expect(multi.decision).toBe('deny')

    const glob = assessCommandLine('pwsh', 'Remove-Item *.log', artifacts, ROOTS)
    expect(glob.decision).toBe('deny')
  })

  it('routine installs flow through; ad-hoc package execution escalates', () => {
    expect(assessCommandLine('bash', 'pnpm install', undefined, ROOTS).decision).toBe('allow')
    expect(assessCommandLine('bash', 'git commit -m x', undefined, ROOTS).decision).toBe('allow')
    expect(assessCommandLine('bash', 'npx some-tool@latest', undefined, ROOTS).decision).toBe('classify')
  })

  it('network mutation and infrastructure tools escalate', () => {
    expect(assessCommandLine('bash', 'curl -d @payload https://api', undefined, ROOTS).decision).toBe('classify')
    expect(assessCommandLine('bash', 'psql -h db -c "select 1"', undefined, ROOTS).decision).toBe('classify')
    expect(assessCommandLine('bash', 'curl https://example.com/file.zip -o f.zip', undefined, ROOTS).decision).toBe('allow')
  })

  it('inline interpreters are never a free pass', () => {
    const risky = assessCommandLine('bash', 'python3 -c "import requests; requests.post(url, data=secret)"', undefined, ROOTS)
    expect(risky.decision).toBe('classify')
    const nestedDelete = assessCommandLine('bash', 'node -e "fs.rmSync(t, {recursive: true})"', undefined, ROOTS)
    expect(nestedDelete.decision).toBe('deny')
    expect(opaqueAssessment('node -e "fs.rmSync(x,{recursive:true})"', ROOTS).decision).toBe('deny')
    expect(opaqueAssessment('python -c "print(math.pi)"', ROOTS).decision).toBe('classify')
  })

  function world2() {
    const fs = makeFs()
    fs.files.set('g:\\work\\proj', { dev: 1, ino: 1, birthtimeMs: 1000, isDirectory: true })
    fs.files.set('g:\\work\\proj\\src', { dev: 1, ino: 5, birthtimeMs: 1100, isDirectory: true })
    fs.files.set('g:\\work\\proj\\src\\main.ts', { dev: 1, ino: 6, birthtimeMs: 1200, isDirectory: false })
    fs.files.set('g:\\work\\proj\\a.txt', { dev: 1, ino: 7, birthtimeMs: 1300, isDirectory: false })
    fs.files.set('g:\\work\\proj\\b.txt', { dev: 1, ino: 8, birthtimeMs: 1400, isDirectory: false })
    const artifacts = new SessionArtifacts(fs, 'G:\\work\\proj', 50_000)
    return { fs, artifacts }
  }
})

describe('fuse + tool policy', () => {
  it('fuse denies privilege escalation, execution-policy changes, credential deletion, critical paths', () => {
    expect(hardDeny('bash', '"sudo apt install x"', ROOTS)?.reason).toContain('privilege escalation')
    expect(hardDeny('pwsh', '"Set-ExecutionPolicy RemoteSigned"', ROOTS)).toBeDefined()
    expect(hardDeny('bash', '"rm -rf C:/Users/dev/.ssh"', ROOTS)?.reason).toContain('credential')
    expect(hardDeny('bash', '"rm G:/"', ROOTS)?.reason).toContain('critical path')
    expect(hardDeny('read', '"G:\\work\\proj\\a.txt"', ROOTS)).toBeUndefined()
  })

  it('tool policy: readonly allowed; stateful terminal classified; out-of-workspace writes classified', () => {
    expect(assessTool('grep', '{"pattern":"x"}', ROOTS).decision).toBe('allow')
    expect(assessTool('terminal_send', '{}', ROOTS).decision).toBe('classify')
    expect(
      assessTool('write', '{"file_path":"D:\\\\elsewhere\\\\x.txt"}', ROOTS).decision,
    ).toBe('classify')
  })
})

describe('classifier protocol + failure ladder', () => {
  it('strict output protocol rejects malformed shapes loudly', () => {
    for (const bad of [
      null,
      {},
      { decision: 'allow' },
      { decision: 'allow', reason: 'r', extra: 1 },
      { decision: 'maybe', reason: 'r' },
      { decision: 'allow', reason: '' },
      { decision: 'allow', reason: 'x'.repeat(1001) },
    ]) {
      expect(() => parseClassifierOutput(bad)).toThrow()
    }
    expect(parseClassifierOutput({ decision: 'ask', reason: 'need confirmation' })).toEqual({
      decision: 'ask',
      reason: 'need confirmation',
    })
  })

  it('ladder denies twice then hands over to a human; success resets; cancelled is free', () => {
    const ladder = new FailureLadder(2)
    ladder.recordFailure('timeout')
    expect(ladder.nextAction()).toBe('deny')
    ladder.recordFailure('schema')
    expect(ladder.nextAction()).toBe('ask') // third failure → human
    ladder.recordSuccess()
    expect(ladder.nextAction()).toBe('deny')
    for (let i = 0; i < 5; i++) ladder.recordFailure('cancelled')
    expect(ladder.currentStreak).toBe(0)
  })

  it('classifier input redacts args and caps direct human messages', () => {
    const input = buildClassifierInput({
      sessionId: 's',
      toolName: 'bash',
      args: { cmd: ['curl -H "Authorization: Bearer abc.def_123"'].join('') },
      facts: { existedBefore: true },
      directHumanMessages: Array.from({ length: 8 }, (_, i) => `msg-${i}`),
    })
    const json = JSON.stringify(input.argsRedacted)
    expect(json).not.toContain('abc.def_123')
    expect(input.directHumanMessages).toHaveLength(4)
    expect(input.facts['existedBefore']).toBe(true)
  })
})

describe('escalation grants (one-shot capabilities)', () => {
  it('exact-match single consumption; settle reclaims unconditionally', () => {
    let t = 1_000_000
    const grants = new EscalationGrants(createToken(), () => t)
    grants.issue({
      sessionId: 's1',
      toolName: 'bash',
      callId: 'call-1',
      level: 'danger-full-access',
      justification: 'needs global npm install',
    })
    expect(grants.size).toBe(1)
    // Wrong-tool probe must NOT consume the grant (fail closed, not burn).
    expect(grants.decide('call-1', 'write')).toBeUndefined()
    expect(grants.decide('call-1', 'bash')).toBe('allowed-once') // correct shape consumes
    expect(grants.decide('call-1', 'bash')).toBeUndefined() // replay blocked
    expect(grants.decide('call-2', 'bash')).toBeUndefined() // replay blocked

    grants.issue({
      sessionId: 's1', toolName: 'bash', callId: 'call-3', level: 'danger-full-access', justification: 'j',
    })
    grants.settle('call-3')
    expect(grants.decide('call-3', 'bash')).toBeUndefined()

    grants.issue({
      sessionId: 's9', toolName: 'bash', callId: 'call-4', level: 'danger-full-access', justification: 'j',
    })
    t += 11 * 60_000 // past TTL
    expect(grants.decide('call-4', 'bash')).toBeUndefined()
  })

  function createToken() {
    let n = 0
    return { token: () => `t${(n += 1)}` }
  }
})

describe('guard module funnel (end-to-end)', () => {
  function module(overrides?: Partial<GuardAdapters>) {
    const kernel = createKernel({})
    const audits: Array<{ layer: string; outcome: string }> = []
    let classifierResponse: unknown = { decision: 'allow', reason: 'safe' }
    const adapters: GuardAdapters = {
      workspaceRoot: () => ROOTS.workspaceRoot,
      homePath: () => ROOTS.homePath,
      dshHomePath: () => ROOTS.dshHomePath,
      fsProbe() {
        const fs = makeFs()
        fs.files.set('g:\\work\\proj', { dev: 1, ino: 1, birthtimeMs: 1, isDirectory: true })
        return fs
      },
      classifierTransport: () => async () => classifierResponse,
      provideDirectUserMessages: () => [],
      humanAsk: async () => 'rejected',
      appendAudit(event) {
        audits.push({ layer: String((event.data as Record<string, unknown>)['layer']), outcome: String((event.data as Record<string, unknown>)['outcome']) })
      },
      isAutoSession: () => true,
      ...overrides,
    }
    const mod = createGuardModule({
      kernel,
      options: {
        enabled: true,
        classifierTimeoutMs: 5000,
        classifyFailDenyStreak: 2,
        snapshotPathLimit: 50_000,
      },
      adapters,
    })
    return { mod, audits, setClassifier: (v: unknown) => (classifierResponse = v), kernel }
  }

  it('non-auto sessions pass straight through without any audit', async () => {
    const { mod, audits } = module({ isAutoSession: () => false })
    const verdict = await mod.handlePreToolUse({
      sessionId: 's', callId: 'c', toolName: 'bash', argsJson: '"sudo rm -rf /"', shell: 'bash',
    })
    expect(verdict.decision).toBe('allow')
    expect(audits).toHaveLength(0)
  })

  it('fuse fires first even when the classifier would allow', async () => {
    const { mod, audits } = module()
    const verdict = await mod.handlePreToolUse({
      sessionId: 's', callId: 'c', toolName: 'bash', argsJson: JSON.stringify('sudo do things'), shell: 'bash',
    })
    expect(verdict.decision).toBe('deny')
    expect(audits[0]).toEqual({ layer: 'fuse', outcome: 'deny' })
  })

  it('classifier deny blocks; classifier failure ladders into ask after streak', async () => {
    const first = module()
    first.setClassifier({ decision: 'deny', reason: 'not authorized by user' })
    const denied = await first.mod.handlePreToolUse({
      sessionId: 's', callId: 'c1', toolName: 'bash', argsJson: JSON.stringify('npx pkg'), shell: 'bash',
    })
    expect(denied.decision).toBe('deny')

    const failing = module({ classifierTransport: () => async () => ({ decision: 'oops' }) })
    await failing.mod.handlePreToolUse({ sessionId: 's', callId: 'd1', toolName: 'bash', argsJson: JSON.stringify('npx pkg'), shell: 'bash' })
    const second = await failing.mod.handlePreToolUse({ sessionId: 's', callId: 'd2', toolName: 'bash', argsJson: JSON.stringify('npx pkg'), shell: 'bash' })
    expect(second.decision).toBe('ask') // ladder handed control to a human
  })

  it('full-access requests bridge to official approval via one-shot grant', async () => {
    const { mod } = module()
    const verdict = await mod.handlePreToolUse({
      sessionId: 's',
      callId: 'esc-1',
      toolName: 'bash',
      argsJson: JSON.stringify({
        sandbox_permissions: 'danger-full-access',
        justification: 'global tool install requested by user',
        command: 'npm i -g thing',
      }),
      shell: 'bash',
    })
    expect(verdict.decision).toBe('delegate-to-official')
    expect(mod.handleApprovalRequest({ callId: 'esc-1', toolName: 'bash' })).toBe('allowed-once')
    expect(mod.handleApprovalRequest({ callId: 'esc-1', toolName: 'bash' })).toBeUndefined()
  })
})
