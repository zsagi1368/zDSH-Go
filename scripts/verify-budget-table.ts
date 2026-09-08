/**
 * Cross-check the locked budget table (packages/llm/model-slots/src/budget.ts
 * `BUDGET_TABLE`) against the authoritative Python reference
 * (scripts/budget-table.py, vendored from tools/budget_table.py v3).
 *
 * The design doc states: "任何数值与脚本不一致即文档错误" and §4 maps
 * "脚本 v2 入仓；7 案例锁表（含 16k/32k）". This gate is the CI half of that
 * mapping: it runs the Python generator and fails on any divergence from the
 * TypeScript lock.
 *
 * Usage: `pnpm verify-budget-table`
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BUDGET_TABLE } from '@deepseek-ai/dsh-model-slots'

const root = resolve(import.meta.dirname, '..')

/** Pick the first available python interpreter. */
function pythonBinary(): string {
  for (const candidate of ['python', 'python3']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('verify-budget-table: no python interpreter found (python or python3 required)')
}

/** One parsed reference row from the Python generator. */
interface ReferenceRow {
  readonly maxTokens: number
  readonly reserve: number
  readonly toolCap: number
  readonly rPess: number
  readonly trigger: number
  readonly keepRecent: number
  readonly summaryInputMax: number
  readonly summaryOutput: number
  readonly subagentReturn: number
  readonly triggerPercent: number
  readonly rMin: number
}

/** Run the authoritative generator and parse its fixed-width table rows. */
function runPythonTable(): Record<string, ReferenceRow> {
  const script = resolve(root, 'scripts/budget-table.py')
  const output = execFileSync(pythonBinary(), [script], { encoding: 'utf8' })
  const rows: Record<string, ReferenceRow> = {}
  // The generator prints fixed-width columns (see the f-string in
  // budget-table.py); slicing by offsets is the only shape that survives
  // labels containing spaces (e.g. "1M cap=64k").
  const columns: Array<{ name: keyof Omit<ReferenceRow, 'triggerPercent' | 'rMin'>; start: number; end: number }> = [
    { name: 'maxTokens', start: 12, end: 19 },
    { name: 'reserve', start: 19, end: 27 },
    { name: 'toolCap', start: 27, end: 35 },
    { name: 'rPess', start: 35, end: 43 },
    { name: 'trigger', start: 43, end: 51 },
    { name: 'keepRecent', start: 58, end: 66 },
    { name: 'summaryInputMax', start: 66, end: 75 },
    { name: 'summaryOutput', start: 75, end: 82 },
    { name: 'subagentReturn', start: 82, end: 88 },
  ]
  const lines = output.split(/\r?\n/).filter(line => line.trim().length > 0)
  const headerIndex = lines.findIndex(line => line.includes('maxTok'))
  if (headerIndex === -1) throw new Error('verify-budget-table: could not locate the generator table header')
  for (const line of lines.slice(headerIndex + 1)) {
    // A table row is any line whose maxTok column [12,19) is numeric; the
    // formula block that follows the table is prose and fails this check.
    if (!/^\s*\d/.test(line.slice(12, 19))) break
    const label = line.slice(0, 12).trim()
    if (label.length === 0) continue
    const row = {} as Record<string, number>
    let ok = true
    for (const { name, start, end } of columns) {
      const value = Number(line.slice(start, end).trim())
      if (!Number.isFinite(value)) {
        ok = false
        break
      }
      row[name] = value
    }
    if (!ok) continue
    // Percentage fields carry a trailing '%': 触发% at [51, 58), r_min at [88, 95).
    const triggerPercent = Number.parseFloat(line.slice(51, 58).trim().replace('%', ''))
    const rMin = Number.parseFloat(line.slice(88, 95).trim().replace('%', ''))
    if (!Number.isFinite(triggerPercent) || !Number.isFinite(rMin)) continue
    rows[label] = {
      maxTokens: row.maxTokens ?? 0,
      reserve: row.reserve ?? 0,
      toolCap: row.toolCap ?? 0,
      rPess: row.rPess ?? 0,
      trigger: row.trigger ?? 0,
      keepRecent: row.keepRecent ?? 0,
      summaryInputMax: row.summaryInputMax ?? 0,
      summaryOutput: row.summaryOutput ?? 0,
      subagentReturn: row.subagentReturn ?? 0,
      triggerPercent,
      rMin,
    }
  }
  if (Object.keys(rows).length === 0) {
    throw new Error('verify-budget-table: the generator produced no parseable table rows')
  }
  return rows
}

const pythonRows = runPythonTable()

const failures: string[] = []
for (const locked of BUDGET_TABLE) {
  const reference = pythonRows[locked.label]
  if (reference === undefined) {
    failures.push(`${locked.label}: missing from the Python reference output`)
    continue
  }
  const checks: Array<[string, number, number]> = [
    ['maxTokens', locked.maxTokens, reference.maxTokens],
    ['reserve', locked.reserve, reference.reserve],
    ['toolCap', locked.toolCap, reference.toolCap],
    ['rPess', locked.rPess, reference.rPess],
    ['trigger', locked.trigger, reference.trigger],
    ['keepRecent', locked.keepRecent, reference.keepRecent],
    ['summaryInputMax', locked.summaryInputMax, reference.summaryInputMax],
    ['summaryOutput', locked.summaryOutput, reference.summaryOutput],
    ['subagentReturn', locked.subagentReturn, reference.subagentReturn],
    ['triggerPercent', locked.triggerPercent, reference.triggerPercent],
    ['rMin', locked.rMin, reference.rMin],
  ]
  for (const [field, lockedValue, referenceValue] of checks) {
    if (Math.abs(lockedValue - referenceValue) > 0.05) {
      failures.push(`${locked.label}.${field}: locked ${lockedValue}, reference ${referenceValue}`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`budget-table mismatch: ${failure}`)
  throw new Error(`verify-budget-table: ${failures.length} mismatch(es) against scripts/budget-table.py`)
}

console.log(`verify-budget-table: ${BUDGET_TABLE.length} locked rows match scripts/budget-table.py`)
