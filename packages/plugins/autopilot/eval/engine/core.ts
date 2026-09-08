/**
 * Offline evaluation engine.
 *
 * Behavior contracts are DATA (YAML cases); observation is pure folding over
 * scripted adapters; verdicts are independent assertions; the process exit
 * code IS the CI gate. Cases drive the real module factories headlessly — no
 * live DSH instance and no API key required.
 *
 * Case schema (per file, one case):
 *   name: string
 *   module: continue | guard | review
 *   setup:            # module-specific adapter scripting
 *     ...             # see runners below
 *   steps:            # ordered event replay
 *     - ...
 *   expect:           # assertions, all must pass
 *     - ...
 */
export interface EvalCase {
  name: string
  module: 'continue' | 'guard' | 'review'
  setup: Record<string, unknown>
  steps: Array<Record<string, unknown>>
  expect: Array<Record<string, unknown>>
}

export interface AssertionResult {
  id: string
  passed: boolean
  expected: unknown
  actual: unknown
}

export interface CaseResult {
  caseName: string
  passed: boolean
  assertions: AssertionResult[]
  error?: string
}

function getPath(obj: unknown, path: string): unknown {
  let cursor: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

export function runAssertion(actualHolder: Record<string, unknown>, spec: Record<string, unknown>): AssertionResult {
  const id = String(spec['id'] ?? 'assertion')
  const actual = getPath(actualHolder, String(spec['of'] ?? ''))
  const matcher = String(spec['is'] ?? spec['contains'] ?? spec['gte'] ?? '')
  if (spec['is'] !== undefined) {
    const expected =
      typeof spec['is'] === 'number' ? spec['is'] : String(spec['is']) === 'true' ? true : String(spec['is']) === 'false' ? false : spec['is']
    return { id, passed: actual === expected, expected, actual }
  }
  if (spec['contains'] !== undefined) {
    return {
      id,
      passed: typeof actual === 'string' && actual.includes(String(spec['contains'])),
      expected: `contains ${String(spec['contains'])}`,
      actual,
    }
  }
  if (spec['gte'] !== undefined) {
    const n = Number(spec['gte'])
    return { id, passed: typeof actual === 'number' && actual >= n, expected: `>= ${n}`, actual }
  }
  void matcher
  return { id, passed: false, expected: 'a known matcher (is|contains|gte)', actual }
}

export function summarize(results: CaseResult[]): { exitCode: number } & Record<string, number> {
  const failed = results.filter(r => !r.passed)
  return {
    exitCode: failed.length === 0 ? 0 : 1,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    assertions: results.reduce((sum, r) => sum + r.assertions.length, 0),
  }
}
