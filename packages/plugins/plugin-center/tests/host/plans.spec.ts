import { describe, expect, it } from 'vitest'
import {
  confirmationPhrase,
  createPlan,
  CpError,
  PlanStore,
} from '../../src/host/plans.js'
import type { CatalogEntry } from '../../src/shared/catalog.js'

const COMMIT = 'c'.repeat(40)

function ghEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'sliverp/dsh-hub-plugin',
    source: 'github',
    owner: 'sliverp',
    repo: 'dsh-hub-plugin',
    pinnedCommit: COMMIT,
    title: { zh: 'Hub', en: 'Hub' },
    summary: { zh: '市场', en: 'Marketplace' },
    category: 'marketplace',
    evidence: 'verified',
    compat: 'exact',
    scriptsPolicy: 'none',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  }
}

describe('plan creation', () => {
  it('rejects github entries without a pinned commit', () => {
    expect(() => createPlan(ghEntry({ pinnedCommit: undefined }), 'install', 'web')).toThrow(CpError)
    try {
      createPlan(ghEntry({ pinnedCommit: 'main' }), 'install', 'web')
    } catch (error) {
      expect((error as CpError).code).toBe('untrusted_source')
    }
  })

  it('codes are random one-shot secrets, not derived content', () => {
    const a = createPlan(ghEntry(), 'install', 'web')
    const b = createPlan(ghEntry(), 'install', 'web')
    // identical content yields identical plan ids…
    expect(a.planId).toBe(b.planId)
    // …but independent confirmation codes, so a leaked id reveals nothing
    expect(a.confirmCode).toMatch(/^[0-9a-f]{12}$/)
    expect(a.confirmCode).not.toBe(b.confirmCode)
  })

  it('different actions or profiles yield different phrases', () => {
    const install = createPlan(ghEntry(), 'install', 'web')
    const update = createPlan(ghEntry(), 'update', 'web')
    const otherProfile = createPlan(ghEntry(), 'install', 'docs')
    expect(confirmationPhrase(install)).not.toBe(confirmationPhrase(update))
    expect(confirmationPhrase(install)).not.toBe(confirmationPhrase(otherProfile))
  })
})

describe('plan store one-shot semantics', () => {
  it('confirms exactly once with the exact phrase', () => {
    const store = new PlanStore()
    const plan = createPlan(ghEntry(), 'install', 'web')
    store.add(plan)
    const phrase = confirmationPhrase(plan)
    expect(store.confirm(plan.planId, phrase).planId).toBe(plan.planId)
    expect(() => store.confirm(plan.planId, phrase)).toThrow(CpError)
    try {
      store.confirm(plan.planId, phrase)
    } catch (error) {
      expect((error as CpError).code).toBe('plan_consumed')
    }
  })

  it('rejects wrong phrases without consuming the plan', () => {
    const store = new PlanStore()
    const plan = createPlan(ghEntry(), 'install', 'web')
    store.add(plan)
    try {
      store.confirm(plan.planId, 'wrong phrase')
    } catch (error) {
      expect((error as CpError).code).toBe('confirmation_mismatch')
    }
    // still confirmable with the right phrase afterwards
    expect(store.confirm(plan.planId, confirmationPhrase(plan)).planId).toBe(plan.planId)
  })

  it('expires stale plans on sweep and rejects their confirmation', async () => {
    const store = new PlanStore(10) // 10ms ttl
    const plan = createPlan(ghEntry(), 'install', 'web')
    store.add(plan)
    await new Promise(r => setTimeout(r, 25))
    expect(store.sweepExpired()).toBe(1)
    expect(store.get(plan.planId)).toBeNull()
    expect(() => store.confirm(plan.planId, confirmationPhrase(plan))).toThrow(CpError)
  })

  it('refuses to overwrite an existing plan id', () => {
    const store = new PlanStore()
    const plan = createPlan(ghEntry(), 'install', 'web')
    store.add(plan)
    expect(() => store.add(plan)).toThrow(CpError)
    // the original pending plan survives untouched
    expect(store.get(plan.planId)?.state).toBe('planned')
  })
})
