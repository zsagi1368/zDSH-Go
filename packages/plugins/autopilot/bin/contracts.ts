#!/usr/bin/env node
/**
 * zdsh-autopilot offline behavior-contract runner (executed via tsx).
 *
 * Usage: pnpm run contracts [glob]
 * Exit code 0 iff every assertion in every case passes. No API key, no live
 * host: cases drive the real module factories through scripted adapters.
 */
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { runAssertion, summarize } from '../eval/engine/core.js'
import type { CaseResult } from '../eval/engine/core.js'
import { runCase } from '../eval/engine/runners.js'

interface CaseDoc {
  name?: string
  module: string
  setup?: Record<string, unknown>
  steps?: Array<Record<string, unknown>>
  expect?: Array<Record<string, unknown>>
}

const here = dirname(fileURLToPath(import.meta.url))
const pattern = process.argv[2] ?? 'cases/**/*.yaml'
const files = globSync(resolve(here, '..', 'eval', pattern))

if (files.length === 0) {
  console.error(`no case files matched ${pattern}`)
  process.exit(2)
}

const results: CaseResult[] = []
for (const file of files) {
  let docs: Array<CaseDoc> = []
  try {
    docs = parseAllDocuments(readFileSync(file, 'utf8')).map(d => d.toJS() as CaseDoc).filter(d => d && typeof d === 'object' && 'module' in d)
  } catch (error) {
    results.push({ caseName: file, passed: false, assertions: [], error: `yaml: ${String(error)}` })
    continue
  }
  if (docs.length === 0) continue
  for (const kase of docs) {
    try {
      const output = await runCase({
        name: kase.name ?? `${file}#${results.length}`,
        module: kase.module,
        setup: kase.setup ?? {},
        steps: kase.steps ?? [],
      })
      const assertions = (kase.expect ?? []).map(spec => runAssertion(output.observed, spec))
      results.push({
        caseName: kase.name ?? file,
        passed: assertions.length > 0 && assertions.every(a => a.passed),
        assertions,
      })
    } catch (error) {
      results.push({
        caseName: String(kase?.name ?? file),
        passed: false,
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

let failedCases = 0
for (const result of results) {
  const mark = result.passed ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${result.caseName}`)
  if (!result.passed) {
    failedCases += 1
    if (result.error !== undefined) console.log(`      error: ${result.error}`)
    for (const a of result.assertions.filter(x => !x.passed)) {
      console.log(`      x ${a.id}: expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`)
    }
  }
}
console.log(`\n${results.length - failedCases}/${results.length} cases passed`)
void summarize
process.exit(failedCases === 0 ? 0 : 1)
