// @vitest-environment jsdom
/**
 * Chip reference bar tests: chips derive from the live draft's @tokens, ×
 * removes exactly that occurrence through the public input action face, and
 * click-to-locate rides the injectable hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { FileHubChips } from '../../src/client/mention/chips.js'

function mount(ui: React.ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(ui)
  })
  return {
    container,
    unmount: () => {
      flushSync(() =>{  root.unmount() })
      container.remove()
    },
  }
}

const settle = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('FileHubChips', () => {
  let mounted: { unmount: () => void } | undefined
  afterEach(() => {
    mounted?.unmount()
    mounted = undefined
  })

  function text(): string {
    return document.body.textContent ?? ''
  }

  it('renders nothing for a token-free draft', async () => {
    const view = mount(<FileHubChips sessionId="s1" draft="plain words only" />)
    mounted = view
    await settle()
    expect(document.querySelector('[data-testid="zdsh-filehub-chips"]')).toBeNull()
  })

  it('renders one chip per draft token with the basename label', async () => {
    const setDraft = vi.fn()
    const view = mount(
      <FileHubChips
        sessionId="s1"
        draft={'see @"docs/my notes.md" and @src/app.ts'}
        inputActions={{ setDraft }}
      />,
    )
    mounted = view
    await settle()
    expect(document.querySelectorAll('[data-testid^="zdsh-filehub-chip-"]')).toHaveLength(2)
    expect(text()).toContain('my notes.md')
    expect(text()).toContain('app.ts')
  })

  it('removes exactly the clicked occurrence via setDraft', async () => {
    const draft = '@a.md then @a.md'
    const setDraft = vi.fn()
    const view = mount(<FileHubChips sessionId="s1" draft={draft} inputActions={{ setDraft }} />)
    mounted = view
    await settle()
    const secondChip = document.querySelector('[data-testid="zdsh-filehub-chip-1"]') as HTMLElement
    const removeButton = secondChip.querySelector('button') as HTMLButtonElement
    removeButton.click()
    expect(setDraft).toHaveBeenCalledTimes(1)
    // The SECOND occurrence [start,end) was cut; the first stays untouched.
    expect(setDraft).toHaveBeenCalledWith('@a.md then ')
  })

  it('locates on chip body click through the injected hook', async () => {
    const onLocate = vi.fn()
    const view = mount(
      <FileHubChips sessionId="s1" draft="@src/main.ts" onLocate={onLocate} inputActions={{ setDraft: () => undefined }} />,
    )
    mounted = view
    await settle()
    ;(document.querySelector('[data-testid="zdsh-filehub-chip-0"]') as HTMLElement).click()
    expect(onLocate).toHaveBeenCalledTimes(1)
    expect(onLocate.mock.calls[0]?.[0]).toMatchObject({ value: 'src/main.ts', start: 0, end: 12 })
  })

  it('reads the draft through the useInput standard-kit hook when provided', async () => {
    let reads = 0
    const useInput = <S,>(selector: (state: { draft: string }) => S): S => {
      reads += 1
      return selector({ draft: '@hooked.ts' })
    }
    const view = mount(<FileHubChips sessionId="s1" useInput={useInput} />)
    mounted = view
    await settle()
    expect(reads).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-testid^="zdsh-filehub-chip-"]')).toHaveLength(1)
  })
})
